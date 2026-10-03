/**
 * Turns a solved velocity/pressure field into the visualization payload the
 * viewer consumes: streamlines, sampled velocity vectors, dead-zone clusters
 * and field statistics.
 */

import { FLUID, Grid, INLET, OUTLET, SOLID, cellCenter } from './grid';
import { SolveResult, sampleField } from './airflowSolver';
import {
  IDeadZone,
  ISimulationStatistics,
  IStreamline,
  IVelocityVector,
  Vector3D,
} from '@/types';

const DEAD_ZONE_THRESHOLD = 0.05; // m/s
const MIN_DEAD_ZONE_VOLUME = 0.05; // m³ - ignore single-cell noise
const MAX_DEAD_ZONES = 60;

export interface FieldSummary {
  streamlines: IStreamline[];
  velocityVectors: IVelocityVector[];
  deadZones: IDeadZone[];
  statistics: ISimulationStatistics;
  pressure: {
    grid: { nx: number; ny: number; nz: number; hx: number; hy: number; hz: number };
    /** Kinematic pressure relative to the domain mean, in Pa (rho = 1.2) */
    values: number[];
  };
}

const AIR_DENSITY = 1.2; // kg/m³ at ~20 °C, used to report pressure in Pa

export function summarizeField(grid: Grid, solution: SolveResult): FieldSummary {
  const statistics = computeStatistics(grid, solution);
  return {
    streamlines: traceStreamlines(grid, solution),
    velocityVectors: sampleVectors(grid, solution),
    deadZones: findDeadZones(grid, solution),
    statistics,
    pressure: {
      grid: {
        nx: grid.nx,
        ny: grid.ny,
        nz: grid.nz,
        hx: round(grid.hx, 4),
        hy: round(grid.hy, 4),
        hz: round(grid.hz, 4),
      },
      values: Array.from(solution.p, (value) => round(value * AIR_DENSITY, 3)),
    },
  };
}

function round(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

function magnitudeAt(solution: SolveResult, c: number): number {
  const { u, v, w } = solution;
  return Math.sqrt(u[c] * u[c] + v[c] * v[c] + w[c] * w[c]);
}

function computeStatistics(grid: Grid, solution: SolveResult): ISimulationStatistics {
  let maxVelocity = 0;
  let minVelocity = Infinity;
  let sumVelocity = 0;
  let maxPressure = -Infinity;
  let minPressure = Infinity;
  let sumPressure = 0;
  let count = 0;

  for (let c = 0; c < grid.n; c++) {
    if (grid.type[c] === SOLID) continue;
    const mag = magnitudeAt(solution, c);
    const pressure = solution.p[c] * AIR_DENSITY;

    if (mag > maxVelocity) maxVelocity = mag;
    if (mag < minVelocity) minVelocity = mag;
    sumVelocity += mag;

    if (pressure > maxPressure) maxPressure = pressure;
    if (pressure < minPressure) minPressure = pressure;
    sumPressure += pressure;
    count++;
  }

  if (count === 0) {
    return {
      maxVelocity: 0,
      avgVelocity: 0,
      minVelocity: 0,
      minPressure: 0,
      maxPressure: 0,
      avgPressure: 0,
    };
  }

  return {
    maxVelocity: round(maxVelocity, 4),
    avgVelocity: round(sumVelocity / count, 4),
    minVelocity: round(minVelocity === Infinity ? 0 : minVelocity, 4),
    minPressure: round(minPressure === Infinity ? 0 : minPressure, 3),
    maxPressure: round(maxPressure === -Infinity ? 0 : maxPressure, 3),
    avgPressure: round(sumPressure / count, 3),
  };
}

/**
 * Sample the velocity field on a coarsened lattice so the viewer draws a
 * readable number of arrows regardless of grid resolution.
 */
function sampleVectors(grid: Grid, solution: SolveResult, target = 1400): IVelocityVector[] {
  const openCells = countOpen(grid);
  const stride = Math.max(1, Math.round(Math.cbrt(openCells / Math.max(target, 1))));
  const vectors: IVelocityVector[] = [];

  for (let k = 0; k < grid.nz; k += stride) {
    for (let j = 0; j < grid.ny; j += stride) {
      for (let i = 0; i < grid.nx; i += stride) {
        const c = i + grid.nx * (j + grid.ny * k);
        if (grid.type[c] === SOLID) continue;

        const mag = magnitudeAt(solution, c);
        const pos = cellCenter(grid, i, j, k);
        const inv = mag > 1e-9 ? 1 / mag : 0;

        vectors.push({
          position: { x: round(pos.x, 3), y: round(pos.y, 3), z: round(pos.z, 3) },
          direction: {
            x: round(solution.u[c] * inv, 4),
            y: round(solution.v[c] * inv, 4),
            z: round(solution.w[c] * inv, 4),
          },
          magnitude: round(mag, 4),
        });
      }
    }
  }

  return vectors;
}

function countOpen(grid: Grid): number {
  let open = 0;
  for (let c = 0; c < grid.n; c++) {
    if (grid.type[c] !== SOLID) open++;
  }
  return open;
}

/**
 * Trace particle paths from the supply diffusers (and a few interior seeds) by
 * integrating the velocity field with a midpoint step.
 */
function traceStreamlines(grid: Grid, solution: SolveResult): IStreamline[] {
  const streamlines: IStreamline[] = [];
  const hMin = Math.min(grid.hx, grid.hy, grid.hz);
  const maxPoints = 500;

  const seeds: Array<{ id: string; point: Vector3D }> = [];

  for (const patch of grid.patches) {
    if (patch.kind !== 'inlet') continue;
    const perPatch = Math.min(patch.cells.length, 14);
    const step = Math.max(1, Math.floor(patch.cells.length / perPatch));
    let seeded = 0;
    for (let n = 0; n < patch.cells.length && seeded < perPatch; n += step, seeded++) {
      const c = patch.cells[n];
      const { i, j, k } = unflatten(grid, c);
      const center = cellCenter(grid, i, j, k);
      // Nudge the seed into the room so the first sample is not clipped.
      seeds.push({
        id: `${patch.id}_${seeded}`,
        point: {
          x: center.x + patch.inward.x * grid.hx * 0.4,
          y: center.y + patch.inward.y * grid.hy * 0.4,
          z: center.z + patch.inward.z * grid.hz * 0.4,
        },
      });
    }
  }

  // A handful of mid-height interior seeds reveal recirculation that the
  // inlet-seeded lines can miss.
  const interiorSeeds = 8;
  for (let s = 0; s < interiorSeeds; s++) {
    const fx = (s % 4 + 0.5) / 4;
    const fy = (Math.floor(s / 4) + 0.5) / 2;
    const point = { x: fx * grid.length, y: fy * grid.width, z: 0.5 * grid.height };
    const c = cellIndexAt(grid, point);
    if (grid.type[c] === SOLID) continue;
    seeds.push({ id: `interior_${s}`, point });
  }

  for (const seed of seeds) {
    const points: Vector3D[] = [];
    const velocities: number[] = [];
    let { x, y, z } = seed.point;

    for (let step = 0; step < maxPoints; step++) {
      if (x < 0 || y < 0 || z < 0 || x > grid.length || y > grid.width || z > grid.height) break;

      const u = sampleField(grid, solution.u, x, y, z);
      const v = sampleField(grid, solution.v, x, y, z);
      const w = sampleField(grid, solution.w, x, y, z);
      const mag = Math.sqrt(u * u + v * v + w * w);

      points.push({ x: round(x, 3), y: round(y, 3), z: round(z, 3) });
      velocities.push(round(mag, 4));

      if (mag < 0.01) break; // stagnated: nothing more to trace

      // Half a cell per step keeps the path smooth without exploding the point count.
      const dt = (0.5 * hMin) / mag;
      const mx = x + 0.5 * dt * u;
      const my = y + 0.5 * dt * v;
      const mz = z + 0.5 * dt * w;
      const um = sampleField(grid, solution.u, mx, my, mz);
      const vm = sampleField(grid, solution.v, mx, my, mz);
      const wm = sampleField(grid, solution.w, mx, my, mz);

      x += dt * um;
      y += dt * vm;
      z += dt * wm;

      if (grid.type[cellIndexAt(grid, { x, y, z })] === SOLID) break;
    }

    if (points.length >= 2) {
      streamlines.push({ id: `streamline_${seed.id}`, points, velocities });
    }
  }

  return streamlines;
}

function unflatten(grid: Grid, c: number): { i: number; j: number; k: number } {
  const i = c % grid.nx;
  const j = Math.floor(c / grid.nx) % grid.ny;
  const k = Math.floor(c / (grid.nx * grid.ny));
  return { i, j, k };
}

function cellIndexAt(grid: Grid, p: Vector3D): number {
  const i = Math.min(grid.nx - 1, Math.max(0, Math.floor(p.x / grid.hx)));
  const j = Math.min(grid.ny - 1, Math.max(0, Math.floor(p.y / grid.hy)));
  const k = Math.min(grid.nz - 1, Math.max(0, Math.floor(p.z / grid.hz)));
  return i + grid.nx * (j + grid.ny * k);
}

/**
 * Flood-fill connected clusters of low-velocity fluid cells and report each
 * cluster's centroid, volume and mean speed.
 */
function findDeadZones(grid: Grid, solution: SolveResult): IDeadZone[] {
  const cellVolume = grid.hx * grid.hy * grid.hz;
  const visited = new Uint8Array(grid.n);
  const zones: IDeadZone[] = [];
  const strideZ = grid.nx * grid.ny;

  const isStagnant = (c: number) =>
    grid.type[c] === FLUID && magnitudeAt(solution, c) < DEAD_ZONE_THRESHOLD;

  const stack: number[] = [];

  for (let start = 0; start < grid.n; start++) {
    if (visited[start] || !isStagnant(start)) continue;

    stack.length = 0;
    stack.push(start);
    visited[start] = 1;

    let cells = 0;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    let sumMag = 0;

    while (stack.length > 0) {
      const c = stack.pop() as number;
      const { i, j, k } = unflatten(grid, c);
      const center = cellCenter(grid, i, j, k);
      cells++;
      sx += center.x;
      sy += center.y;
      sz += center.z;
      sumMag += magnitudeAt(solution, c);

      const neighbours = [
        i > 0 ? c - 1 : -1,
        i < grid.nx - 1 ? c + 1 : -1,
        j > 0 ? c - grid.nx : -1,
        j < grid.ny - 1 ? c + grid.nx : -1,
        k > 0 ? c - strideZ : -1,
        k < grid.nz - 1 ? c + strideZ : -1,
      ];

      for (const nb of neighbours) {
        if (nb < 0 || visited[nb] || !isStagnant(nb)) continue;
        visited[nb] = 1;
        stack.push(nb);
      }
    }

    const volume = cells * cellVolume;
    if (volume < MIN_DEAD_ZONE_VOLUME) continue;

    zones.push({
      position: { x: round(sx / cells, 3), y: round(sy / cells, 3), z: round(sz / cells, 3) },
      volume: round(volume, 3),
      velocityMagnitude: round(sumMag / cells, 4),
    });
  }

  zones.sort((a, b) => b.volume - a.volume);
  return zones.slice(0, MAX_DEAD_ZONES);
}

/** Diagnostics written alongside the results so a run can be inspected later. */
export function buildRunReport(grid: Grid, solution: SolveResult) {
  let fluid = 0;
  let solid = 0;
  let inlet = 0;
  let outlet = 0;
  for (let c = 0; c < grid.n; c++) {
    switch (grid.type[c]) {
      case SOLID:
        solid++;
        break;
      case INLET:
        inlet++;
        break;
      case OUTLET:
        outlet++;
        break;
      default:
        fluid++;
    }
  }

  const roomVolume = grid.length * grid.width * grid.height;

  return {
    engine: 'builtin',
    grid: { nx: grid.nx, ny: grid.ny, nz: grid.nz, cells: grid.n, hx: grid.hx, hy: grid.hy, hz: grid.hz },
    cellCounts: { fluid, solid, inlet, outlet },
    supplyFlowM3s: round(grid.supplyFlow, 5),
    achAchieved: round((grid.supplyFlow * 3600) / roomVolume, 2),
    solver: {
      steps: solution.steps,
      residual: solution.residual,
      converged: solution.converged,
      dt: solution.dt,
      effectiveViscosity: solution.nuEff,
    },
  };
}
