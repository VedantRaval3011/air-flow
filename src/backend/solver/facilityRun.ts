/**
 * Whole-floor airflow run: builds the facility grid, solves it, and reduces
 * the field to what the facility viewer shows: streamlines from every
 * terminal, a working-height vector slice, dead zones, per-room figures, and
 * the air moving through each door checked against the RDS pressure cascade.
 */

import {
  Facility,
  FacilityDoor,
  FacilityRoom,
  FacilityResults,
  FacilitySimulationOptions,
  PlanRect,
  SpeedSection,
  SpeedSlice,
  VelocityField,
} from '@/lib/facility/types';
import { CFM_TO_M3S, WALL_THICKNESS, cascadeDirection, computeWalls, placeTerminals, roomVolume } from '@/lib/facility/geometry';
import { BoundaryDoor, buildFacilityGrid, FacilityGrid, FacilityGridOptions, withRoomFlows } from './facilityGrid';
import { SolveResult, sampleField, solveAirflowAsync } from './airflowSolver';
import * as cellTypes from './grid';

const FLUID = cellTypes.FLUID;
const SOLID = cellTypes.SOLID;

/** Below this speed air is treated as stagnant (m/s). */
const STAGNANT = 0.05;
/** Occupied / working zone used for room figures (m above floor). */
const WORK_ZONE = { lo: 0.5, hi: 1.8 };
const SLICE_HEIGHT = 1.2;

export interface FacilityRunOptions extends FacilitySimulationOptions {
  maxSteps?: number;
  onProgress?: (fraction: number, message: string) => void;
}

/** Largest grid a room study builds; the cell size is chosen to fit it. */
const ROOM_STUDY_CELLS = 170_000;

export async function runFacilitySimulation(
  jobId: string,
  input: Facility,
  options: FacilityRunOptions
): Promise<FacilityResults> {
  const report = options.onProgress ?? (() => undefined);
  const started = Date.now();
  const study = options.roomIds?.length ? roomStudy(input, options) : null;
  const facility = study?.facility ?? input;
  const gridOptions = study?.options ?? options;

  report(0.02, study ? `Building a ${gridOptions.cellSize} m grid of the room...` : 'Building the floor grid from the layout...');
  const fg = buildFacilityGrid(facility, gridOptions);
  const { grid } = fg;
  if (grid.supplyFlow <= 0) throw new Error('The layout has no supply air terminals.');

  const maxSteps = options.maxSteps ?? (study ? 420 : 320);
  report(0.06, `Solving ${grid.nx}×${grid.ny}×${grid.nz} cells...`);
  const solution = await solveAirflowAsync(grid, {
    maxSteps,
    averageLast: Math.round(maxSteps / 3),
    onProgress: (fraction, info) =>
      report(0.06 + fraction * 0.84, `Solving flow field — iteration ${info.step}, residual ${info.residual.toFixed(3)}`),
  });
  const seconds = (Date.now() - started) / 1000;

  report(0.92, 'Tracing streamlines and summarising rooms...');
  const speed = magnitude(grid, solution);

  let fluidCells = 0;
  let maxVelocity = 0;
  let sumVelocity = 0;
  let open = 0;
  for (let c = 0; c < grid.n; c++) {
    if (grid.type[c] === SOLID) continue;
    open++;
    if (grid.type[c] === FLUID) fluidCells++;
    sumVelocity += speed[c];
    if (speed[c] > maxVelocity) maxVelocity = speed[c];
  }

  const doors = [...doorFlows(facility, fg, solution), ...(study?.boundaryResults ?? [])];
  const withBoundary = study ? { ...facility, doors: [...facility.doors, ...study.boundary.map((b) => b.door)] } : facility;
  const results: FacilityResults = {
    jobId,
    roomIds: options.roomIds?.length ? options.roomIds : null,
    doorMode: options.doorMode,
    grid: { nx: grid.nx, ny: grid.ny, nz: grid.nz, hx: r3(grid.hx), hy: r3(grid.hy), hz: r3(grid.hz), fluidCells },
    solver: { steps: solution.steps, residual: r3(solution.residual), converged: solution.converged, seconds: r1(seconds) },
    flowBalance: {
      supplyM3h: r1(grid.supplyFlow * 3600),
      extractDesignM3h: r1(fg.extractDesign * 3600),
      extractScale: r3(fg.extractScale),
    },
    statistics: { maxVelocity: r3(maxVelocity), avgVelocity: r3(open > 0 ? sumVelocity / open : 0) },
    rooms: roomFigures(withBoundary, fg, speed, doors),
    doors,
    streamlines: traceStreamlines(fg, solution, study ? 8 : 4),
    vectors: vectorSlice(fg, solution, speed, study ? 1 : 2),
    deadZones: deadZones(facility, fg, speed),
    slice: speedSlice(fg, speed),
    section: study && facility.rooms.length === 1 ? speedSection(facility, fg, solution, speed) : undefined,
    field: study ? velocityField(fg, solution) : undefined,
    warnings: fg.warnings,
  };

  if (!solution.converged) {
    results.warnings.push(
      `The flow keeps shedding eddies rather than settling (residual ${solution.residual.toFixed(3)}), so the field shown is the average of the last ${Math.round(maxSteps / 3)} iterations.`
    );
  }
  return study ? shiftResults(results, study.origin.x, study.origin.y) : results;
}

// ============= Room studies =============

interface RoomStudy {
  facility: Facility;
  options: FacilityGridOptions;
  boundary: BoundaryDoor[];
  boundaryResults: FacilityResults['doors'];
  origin: { x: number; y: number };
}

/**
 * Cut the chosen rooms out of the floor and move them to local coordinates.
 * Doors to rooms that are not being solved become imposed-flow openings,
 * carrying exactly what the pressure network says passes through them.
 */
function roomStudy(facility: Facility, options: FacilityRunOptions): RoomStudy {
  const ids = new Set(options.roomIds);
  const rooms = facility.rooms.filter((r) => ids.has(r.id));
  if (rooms.length === 0) throw new Error('None of the requested rooms exist in this layout.');
  // The air space ends at the inner face of each wall: walls are drawn on the
  // room outline, so without this the outer 5 cm of every room would be air
  // inside the drawn wall, and air running along a wall would appear in it.
  const inset = rooms.map((r) => ({ ...r, rects: insideWalls(r, rooms) }));
  const rects = inset.flatMap((r) => r.rects);
  const ox = Math.min(...rects.map((r) => r.x0));
  const oy = Math.min(...rects.map((r) => r.y0));
  const width = Math.max(...rects.map((r) => r.x1)) - ox;
  const depth = Math.max(...rects.map((r) => r.y1)) - oy;
  const height = Math.max(...rooms.map((r) => r.height));

  const shiftRect = (r: PlanRect): PlanRect => ({ x0: r.x0 - ox, y0: r.y0 - oy, x1: r.x1 - ox, y1: r.y1 - oy });
  const shiftDoor = (d: FacilityDoor): FacilityDoor => ({ ...d, x: d.x - ox, y: d.y - oy });

  const interior = facility.doors.filter((d) => ids.has(d.rooms[0]) && d.rooms[1] !== null && ids.has(d.rooms[1]));
  const boundaryDoors = facility.doors.filter((d) => ids.has(d.rooms[0]) !== (d.rooms[1] !== null && ids.has(d.rooms[1])));
  const boundary: BoundaryDoor[] = boundaryDoors.map((d) => {
    const flow = (options.doorFlowsCfm?.[d.id] ?? 0) * CFM_TO_M3S; // rooms[0] → rooms[1]
    const inside = ids.has(d.rooms[0]) ? d.rooms[0] : (d.rooms[1] as string);
    return {
      door: shiftDoor(d),
      inside,
      flowIn: inside === d.rooms[0] ? -flow : flow,
      open: options.doorsOpen?.[d.id] ?? options.doorMode === 'open',
    };
  });

  const sub: Facility = {
    ...facility,
    extent: { width, depth },
    rooms: inset.map((r) => ({ ...r, rects: r.rects.map(shiftRect), openTo: r.openTo?.filter((o) => ids.has(o)) })),
    doors: interior.map(shiftDoor),
    objects: [],
    contextRooms: [],
  };

  const objects = (options.objects ?? facility.objects ?? [])
    .filter((o) => ids.has(o.roomId))
    .map((o) => ({ ...o, x: o.x - ox, y: o.y - oy }));
  // Terminals exactly as placed on the whole floor (with the user's moves and
  // the current room flows), shifted into the room's local frame. Placing them
  // again on the cut-out room would move risers, since door positions and
  // which walls are shared both change.
  const floorWithFlows = withRoomFlows(facility, options.roomFlows);
  const terminals = placeTerminals(floorWithFlows, computeWalls(floorWithFlows), options.terminalMoves ?? {})
    .filter((t) => ids.has(t.roomId))
    .map((t) => ({ ...t, x: t.x - ox, y: t.y - oy }));

  // As fine as the cell budget allows, between 10 and 25 cm.
  const ideal = Math.cbrt((width * depth * height) / ROOM_STUDY_CELLS);
  const cellSize = Math.min(0.25, Math.max(0.1, Math.ceil(ideal / 0.025) * 0.025));

  return {
    facility: sub,
    options: { ...options, objects, terminals, cellSize, boundaryDoors: boundary },
    boundary,
    boundaryResults: boundaryDoors.map((d) => {
      const flow = options.doorFlowsCfm?.[d.id] ?? 0;
      return {
        doorId: d.id,
        flowM3h: r1(flow * CFM_TO_M3S * 3600),
        expected: cascadeDirection(facility, d),
        agrees: null,
      };
    }),
    origin: { x: ox, y: oy },
  };
}

/**
 * A room's footprint pulled in by half a wall thickness on every edge that is
 * a wall. Edges shared with another part of the same room, or with a room it
 * opens into (both being studied), stay where they are.
 */
function insideWalls(room: FacilityRoom, studied: FacilityRoom[]): PlanRect[] {
  const half = WALL_THICKNESS / 2;
  const eps = 1e-6;
  const peers = studied
    .filter((o) => o.id === room.id || room.openTo?.includes(o.id) || o.openTo?.includes(room.id))
    .flatMap((o) => o.rects);
  const overlaps = (a0: number, a1: number, b0: number, b1: number) => Math.min(a1, b1) - Math.max(a0, b0) > eps;
  return room.rects.map((r) => {
    const open = (edge: 'x0' | 'x1' | 'y0' | 'y1') =>
      peers.some((q) => {
        if (q === r) return false;
        if (edge === 'x0') return Math.abs(q.x1 - r.x0) < eps && overlaps(q.y0, q.y1, r.y0, r.y1);
        if (edge === 'x1') return Math.abs(q.x0 - r.x1) < eps && overlaps(q.y0, q.y1, r.y0, r.y1);
        if (edge === 'y0') return Math.abs(q.y1 - r.y0) < eps && overlaps(q.x0, q.x1, r.x0, r.x1);
        return Math.abs(q.y0 - r.y1) < eps && overlaps(q.x0, q.x1, r.x0, r.x1);
      });
    return {
      x0: open('x0') ? r.x0 : r.x0 + half,
      x1: open('x1') ? r.x1 : r.x1 - half,
      y0: open('y0') ? r.y0 : r.y0 + half,
      y1: open('y1') ? r.y1 : r.y1 - half,
    };
  });
}

/** Move a room study's output back to floor coordinates. */
function shiftResults(r: FacilityResults, dx: number, dy: number): FacilityResults {
  return {
    ...r,
    streamlines: r.streamlines.map((s) => ({
      ...s,
      points: s.points.map((v, i) => (i % 3 === 0 ? r2(v + dx) : i % 3 === 1 ? r2(v + dy) : v)),
    })),
    vectors: r.vectors.map((v) => ({ ...v, p: [r2(v.p[0] + dx), r2(v.p[1] + dy), v.p[2]] })),
    deadZones: r.deadZones.map((z) => ({ ...z, x: r2(z.x + dx), y: r2(z.y + dy) })),
    slice: { ...r.slice, x0: r3(r.slice.x0 + dx), y0: r3(r.slice.y0 + dy) },
    field: r.field ? { ...r.field, x0: r3(r.field.x0 + dx), y0: r3(r.field.y0 + dy) } : undefined,
    section: r.section
      ? {
          ...r.section,
          at: r3(r.section.at + (r.section.axis === 'x' ? dy : dx)),
          from: r3(r.section.from + (r.section.axis === 'x' ? dx : dy)),
        }
      : undefined,
  };
}

// ============= Velocity field (room studies) =============

/**
 * Coarsen the exactly conserving face velocities to ~20 cm blocks: each coarse
 * face carries the total flux of the fine faces it covers, spread over the
 * coarse face's full area, so mass is conserved block by block even where a
 * room's size is not a whole number of blocks (the last block is then partly
 * outside the room but carries exactly the room's air).
 */
function velocityField(fg: FacilityGrid, s: SolveResult): VelocityField {
  const { grid } = fg;
  const f = Math.max(1, Math.round(0.2 / grid.hx));
  const nx = Math.ceil(grid.nx / f);
  const ny = Math.ceil(grid.ny / f);
  const nz = Math.ceil(grid.nz / f);
  const plane = grid.nx * grid.ny;
  const fine = (i: number, j: number, k: number) => i + grid.nx * j + plane * k;
  const faces = s.faces;
  const cellVel = [s.u, s.v, s.w];

  // Fine face velocity on the + side of cell (i, j, k) along axis a. Without
  // the projection's faces, fall back to the mean of the two cells.
  const faceAt = (a: number, i: number, j: number, k: number): number => {
    const c = fine(i, j, k);
    if (faces) return faces[a][c];
    const nb = a === 0 ? c + 1 : a === 1 ? c + grid.nx : c + plane;
    if (grid.type[c] === SOLID || grid.type[nb] === SOLID) return 0;
    return 0.5 * (cellVel[a][c] + cellVel[a][nb]);
  };

  const fx: number[] = new Array((nx + 1) * ny * nz).fill(0);
  const fy: number[] = new Array(nx * (ny + 1) * nz).fill(0);
  const fz: number[] = new Array(nx * ny * (nz + 1)).fill(0);
  const solid: number[] = new Array(nx * ny * nz).fill(1);

  for (let K = 0; K < nz; K++) {
    for (let J = 0; J < ny; J++) {
      for (let I = 0; I < nx; I++) {
        const i0 = I * f;
        const j0 = J * f;
        const k0 = K * f;
        const i1 = Math.min(grid.nx, (I + 1) * f) - 1;
        const j1 = Math.min(grid.ny, (J + 1) * f) - 1;
        const k1 = Math.min(grid.nz, (K + 1) * f) - 1;

        // Solid only when the block holds no air at all. A partly open block
        // still carries air through its faces, so parcels must be able to
        // follow that air through it rather than stall at its edge.
        let air = 0;
        for (let k = k0; k <= k1; k++)
          for (let j = j0; j <= j1; j++)
            for (let i = i0; i <= i1; i++) {
              if (grid.type[fine(i, j, k)] !== SOLID) air++;
            }
        solid[I + nx * (J + ny * K)] = air > 0 ? 0 : 1;

        // + side faces of the block; faces on the domain edge stay 0.
        if (i1 < grid.nx - 1) {
          let sum = 0;
          for (let k = k0; k <= k1; k++)
            for (let j = j0; j <= j1; j++) sum += faceAt(0, i1, j, k);
          fx[I + 1 + (nx + 1) * (J + ny * K)] = r3(sum / (f * f));
        }
        if (j1 < grid.ny - 1) {
          let sum = 0;
          for (let k = k0; k <= k1; k++)
            for (let i = i0; i <= i1; i++) sum += faceAt(1, i, j1, k);
          fy[I + nx * (J + 1 + (ny + 1) * K)] = r3(sum / (f * f));
        }
        if (k1 < grid.nz - 1) {
          let sum = 0;
          for (let j = j0; j <= j1; j++)
            for (let i = i0; i <= i1; i++) sum += faceAt(2, i, j, k1);
          fz[I + nx * (J + ny * (K + 1))] = r3(sum / (f * f));
        }
      }
    }
  }
  return {
    x0: 0,
    y0: 0,
    nx,
    ny,
    nz,
    h: [r3(grid.hx * f), r3(grid.hy * f), r3(grid.hz * f)],
    fx,
    fy,
    fz,
    solid,
    extent: [r3(grid.nx * grid.hx), r3(grid.ny * grid.hy)],
  };
}

// ============= Slices =============

/** Speed in every cell of the working-height plane, for the colour map. */
function speedSlice(fg: FacilityGrid, speed: Float32Array): SpeedSlice {
  const { grid } = fg;
  const k = Math.min(grid.nz - 1, Math.floor(SLICE_HEIGHT / grid.hz));
  const values: number[] = new Array(grid.nx * grid.ny);
  for (let j = 0; j < grid.ny; j++) {
    for (let i = 0; i < grid.nx; i++) {
      const c = i + grid.nx * (j + grid.ny * k);
      values[i + grid.nx * j] = grid.type[c] === SOLID ? -1 : r3(speed[c]);
    }
  }
  return { z: r2((k + 0.5) * grid.hz), x0: 0, y0: 0, nx: grid.nx, ny: grid.ny, hx: r3(grid.hx), hy: r3(grid.hy), speed: values };
}

/** Vertical cut down the long axis of a single-room study, through its centre. */
function speedSection(facility: Facility, fg: FacilityGrid, s: SolveResult, speed: Float32Array): SpeedSection {
  const { grid } = fg;
  const room = facility.rooms[0];
  const r = room.rects.reduce((a, b) => ((b.x1 - b.x0) * (b.y1 - b.y0) > (a.x1 - a.x0) * (a.y1 - a.y0) ? b : a));
  const axis: 'x' | 'y' = r.x1 - r.x0 >= r.y1 - r.y0 ? 'x' : 'y';
  const at = axis === 'x' ? (r.y0 + r.y1) / 2 : (r.x0 + r.x1) / 2;
  const fixed = axis === 'x' ? Math.min(grid.ny - 1, Math.floor(at / grid.hy)) : Math.min(grid.nx - 1, Math.floor(at / grid.hx));
  const nAlong = axis === 'x' ? grid.nx : grid.ny;
  const values: number[] = [];
  const along: number[] = [];
  const w: number[] = [];
  for (let k = 0; k < grid.nz; k++) {
    for (let a = 0; a < nAlong; a++) {
      const c = axis === 'x' ? a + grid.nx * (fixed + grid.ny * k) : fixed + grid.nx * (a + grid.ny * k);
      const solid = grid.type[c] === SOLID;
      values.push(solid ? -1 : r3(speed[c]));
      along.push(solid ? 0 : r3(axis === 'x' ? s.u[c] : s.v[c]));
      w.push(solid ? 0 : r3(s.w[c]));
    }
  }
  return {
    axis,
    at: r3(axis === 'x' ? (fixed + 0.5) * grid.hy : (fixed + 0.5) * grid.hx),
    from: 0,
    nAlong,
    nz: grid.nz,
    hAlong: r3(axis === 'x' ? grid.hx : grid.hy),
    hz: r3(grid.hz),
    speed: values,
    along,
    w,
  };
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

function magnitude(grid: FacilityGrid['grid'], s: SolveResult): Float32Array {
  const m = new Float32Array(grid.n);
  for (let c = 0; c < grid.n; c++) {
    if (grid.type[c] === SOLID) continue;
    m[c] = Math.sqrt(s.u[c] * s.u[c] + s.v[c] * s.v[c] + s.w[c] * s.w[c]);
  }
  return m;
}

function cellZ(grid: FacilityGrid['grid'], c: number): number {
  return (Math.floor(c / (grid.nx * grid.ny)) + 0.5) * grid.hz;
}

// ============= Doors =============

function doorFlows(facility: Facility, fg: FacilityGrid, s: SolveResult): FacilityResults['doors'] {
  const { grid } = fg;
  const out: FacilityResults['doors'] = [];
  for (const door of facility.doors) {
    if (!door.rooms[1]) continue;
    const cells = fg.doorCells.get(door.id);
    if (!cells) continue;
    // Flux through the opening, positive towards +x / +y.
    let flux = 0;
    for (const c of cells.cells) {
      flux += door.axis === 'x' ? s.v[c] * grid.hx * grid.hz : s.u[c] * grid.hy * grid.hz;
    }
    // +axis runs from the low-side room to the other one.
    const forwardSign = cells.lowRoom === door.rooms[0] ? 1 : -1;
    const flowM3h = forwardSign * flux * 3600;
    const expected = cascadeDirection(facility, door);
    const significant = Math.abs(flowM3h) > 5;
    out.push({
      doorId: door.id,
      flowM3h: r1(flowM3h),
      expected,
      agrees:
        expected === 'none' || !significant
          ? null
          : (expected === 'forward') === flowM3h > 0,
    });
  }
  return out;
}

// ============= Rooms =============

function roomFigures(
  facility: Facility,
  fg: FacilityGrid,
  speed: Float32Array,
  doors: FacilityResults['doors']
): FacilityResults['rooms'] {
  const { grid, cellRoom } = fg;
  const count = facility.rooms.length;
  const cells = new Float64Array(count);
  const sum = new Float64Array(count);
  const workCells = new Float64Array(count);
  const workSum = new Float64Array(count);
  const stagnant = new Float64Array(count);

  for (let c = 0; c < grid.n; c++) {
    const r = cellRoom[c];
    if (r < 0 || grid.type[c] === SOLID) continue;
    cells[r]++;
    sum[r] += speed[c];
    const z = cellZ(grid, c);
    if (z >= WORK_ZONE.lo && z <= WORK_ZONE.hi) {
      workCells[r]++;
      workSum[r] += speed[c];
    }
    if (grid.type[c] === FLUID && speed[c] < STAGNANT) stagnant[r]++;
  }

  const supply = new Float64Array(count);
  const extract = new Float64Array(count);
  const index = new Map(facility.rooms.map((room, i) => [room.id, i]));
  for (const p of grid.patches) {
    // Door openings of a room study are leakage, not the room's supply / extract.
    if (p.id.startsWith('door:')) continue;
    const r = index.get(fg.patchRoom.get(p.id) ?? '');
    if (r === undefined) continue;
    const q = p.velocity * p.area;
    if (p.kind === 'inlet') supply[r] += q;
    else extract[r] += q;
  }

  const doorOut = new Float64Array(count);
  for (const d of doors) {
    const door = facility.doors.find((x) => x.id === d.doorId);
    if (!door || !door.rooms[1]) continue;
    const a = index.get(door.rooms[0]);
    const b = index.get(door.rooms[1]);
    if (a !== undefined) doorOut[a] += d.flowM3h;
    if (b !== undefined) doorOut[b] -= d.flowM3h;
  }

  return facility.rooms.map((room, r) => ({
    roomId: room.id,
    supplyM3h: r1(supply[r] * 3600),
    extractM3h: r1(extract[r] * 3600),
    achievedAcph: r1((supply[r] * 3600) / Math.max(roomVolume(room), 1e-6)),
    meanSpeed: r3(cells[r] > 0 ? sum[r] / cells[r] : 0),
    workingZoneSpeed: r3(workCells[r] > 0 ? workSum[r] / workCells[r] : 0),
    stagnantFraction: r3(cells[r] > 0 ? stagnant[r] / cells[r] : 0),
    netDoorOutflowM3h: r1(doorOut[r]),
  }));
}

// ============= Streamlines =============

function traceStreamlines(fg: FacilityGrid, s: SolveResult, maxPerPatch: number): FacilityResults['streamlines'] {
  const { grid } = fg;
  const seeds: { id: string; roomId: string | null; x: number; y: number; z: number }[] = [];

  for (const p of grid.patches) {
    if (p.kind !== 'inlet') continue;
    // A few seeds per terminal, spread over its face.
    const per = Math.min(p.cells.length, maxPerPatch);
    for (let q = 0; q < per; q++) {
      const c = p.cells[Math.floor(((q + 0.5) * p.cells.length) / per)];
      const { x, y, z } = centre(grid, c);
      seeds.push({
        id: `${p.id}-${q}`,
        roomId: fg.patchRoom.get(p.id) ?? null,
        x: x + p.inward.x * grid.hx * 0.45,
        y: y + p.inward.y * grid.hy * 0.45,
        z: z + p.inward.z * grid.hz * 0.45,
      });
    }
  }
  // One line through each door gap shows which way the leakage goes.
  for (const [doorId, d] of fg.doorCells) {
    if (d.cells.length === 0) continue;
    const c = d.cells[Math.floor(d.cells.length / 2)];
    const { x, y, z } = centre(grid, c);
    seeds.push({ id: `door-${doorId}`, roomId: null, x, y, z });
  }

  const hMin = Math.min(grid.hx, grid.hy, grid.hz);
  const maxPoints = 360;
  const out: FacilityResults['streamlines'] = [];

  for (const seed of seeds) {
    const points: number[] = [];
    const speeds: number[] = [];
    let { x, y, z } = seed;
    for (let step = 0; step < maxPoints; step++) {
      if (!insideOpen(grid, x, y, z)) break;
      const u = sampleField(grid, s.u, x, y, z);
      const v = sampleField(grid, s.v, x, y, z);
      const w = sampleField(grid, s.w, x, y, z);
      const mag = Math.sqrt(u * u + v * v + w * w);
      if (step % 2 === 0) {
        points.push(r2(x), r2(y), r2(z));
        speeds.push(r3(mag));
      }
      if (mag < 0.008) break;
      const dt = (0.5 * hMin) / mag;
      const mx = x + 0.5 * dt * u;
      const my = y + 0.5 * dt * v;
      const mz = z + 0.5 * dt * w;
      x += dt * sampleField(grid, s.u, mx, my, mz);
      y += dt * sampleField(grid, s.v, mx, my, mz);
      z += dt * sampleField(grid, s.w, mx, my, mz);
    }
    if (points.length >= 6) out.push({ id: seed.id, roomId: seed.roomId, points, speeds });
  }
  return out;
}

function centre(grid: FacilityGrid['grid'], c: number) {
  const i = c % grid.nx;
  const j = Math.floor(c / grid.nx) % grid.ny;
  const k = Math.floor(c / (grid.nx * grid.ny));
  return { x: (i + 0.5) * grid.hx, y: (j + 0.5) * grid.hy, z: (k + 0.5) * grid.hz };
}

function insideOpen(grid: FacilityGrid['grid'], x: number, y: number, z: number): boolean {
  if (x < 0 || y < 0 || z < 0 || x >= grid.length || y >= grid.width || z >= grid.height) return false;
  const i = Math.floor(x / grid.hx);
  const j = Math.floor(y / grid.hy);
  const k = Math.floor(z / grid.hz);
  return grid.type[i + grid.nx * (j + grid.ny * k)] !== SOLID;
}

// ============= Vector slice =============

function vectorSlice(fg: FacilityGrid, s: SolveResult, speed: Float32Array, stride: number): FacilityResults['vectors'] {
  const { grid } = fg;
  const k = Math.min(grid.nz - 1, Math.floor(SLICE_HEIGHT / grid.hz));
  const out: FacilityResults['vectors'] = [];
  for (let j = stride >> 1; j < grid.ny; j += stride) {
    for (let i = stride >> 1; i < grid.nx; i += stride) {
      const c = i + grid.nx * (j + grid.ny * k);
      if (grid.type[c] === SOLID) continue;
      const m = speed[c];
      const inv = m > 1e-9 ? 1 / m : 0;
      out.push({
        p: [r2((i + 0.5) * grid.hx), r2((j + 0.5) * grid.hy), r2((k + 0.5) * grid.hz)],
        d: [r3(s.u[c] * inv), r3(s.v[c] * inv), r3(s.w[c] * inv)],
        m: r3(m),
      });
    }
  }
  return out;
}

// ============= Dead zones =============

function deadZones(facility: Facility, fg: FacilityGrid, speed: Float32Array): FacilityResults['deadZones'] {
  const { grid, cellRoom } = fg;
  const plane = grid.nx * grid.ny;
  const cellVolume = grid.hx * grid.hy * grid.hz;
  const seen = new Uint8Array(grid.n);
  const stack: number[] = [];
  const zones: FacilityResults['deadZones'] = [];

  const stagnantAt = (c: number) =>
    grid.type[c] === FLUID && speed[c] < STAGNANT && cellZ(grid, c) <= WORK_ZONE.hi;

  for (let start = 0; start < grid.n; start++) {
    if (seen[start] || !stagnantAt(start)) continue;
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    let cells = 0;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    let sv = 0;
    const votes = new Map<number, number>();
    while (stack.length) {
      const c = stack.pop() as number;
      const p = centre(grid, c);
      cells++;
      sx += p.x;
      sy += p.y;
      sz += p.z;
      sv += speed[c];
      votes.set(cellRoom[c], (votes.get(cellRoom[c]) ?? 0) + 1);
      const i = c % grid.nx;
      const j = Math.floor(c / grid.nx) % grid.ny;
      const k = Math.floor(c / plane);
      const nbs = [
        i > 0 ? c - 1 : -1,
        i < grid.nx - 1 ? c + 1 : -1,
        j > 0 ? c - grid.nx : -1,
        j < grid.ny - 1 ? c + grid.nx : -1,
        k > 0 ? c - plane : -1,
        k < grid.nz - 1 ? c + plane : -1,
      ];
      for (const nb of nbs) {
        if (nb < 0 || seen[nb] || !stagnantAt(nb)) continue;
        seen[nb] = 1;
        stack.push(nb);
      }
    }
    const volume = cells * cellVolume;
    if (volume < 0.2) continue;
    let room = -1;
    let most = 0;
    for (const [r, v] of votes) if (v > most) { most = v; room = r; }
    zones.push({
      roomId: room >= 0 ? facility.rooms[room].id : null,
      x: r2(sx / cells),
      y: r2(sy / cells),
      z: r2(sz / cells),
      volume: r2(volume),
      speed: r3(sv / cells),
    });
  }
  zones.sort((a, b) => b.volume - a.volume);
  return zones.slice(0, 80);
}

