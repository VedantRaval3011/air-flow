/**
 * Built-in incompressible airflow solver.
 *
 * A pressure-projection (fractional step) scheme on the Cartesian grid from
 * grid.ts, marched to a steady state:
 *
 *   1. advection    - semi-Lagrangian backtrace (unconditionally stable)
 *   2. diffusion    - explicit Laplacian with an effective (molecular + eddy)
 *                     viscosity, sub-cycled to stay inside the stability limit
 *   3. projection   - solve  lap(phi) = div(u)  with SOR, then u -= grad(phi)
 *
 * Walls and obstructions are no-slip. Supply/return cells hold their
 * prescribed velocity and are excluded from the pressure correction, so the
 * Poisson problem is pure Neumann; its mean divergence is removed to keep it
 * compatible (the grid builder already balances supply and extract flow).
 *
 * This is a RANS-style steady solution with a constant eddy viscosity rather
 * than a full k-epsilon closure: enough for velocity distribution, dead-zone
 * detection and streamlines, and it runs in-process with no OpenFOAM.
 */

import * as cellTypes from './grid';
import { Grid } from './grid';
import { calculateKinematicViscosity } from '@/lib/physics/airflowCalculations';

// Local copies of the cell-type constants. Bundlers compile imported bindings
// to getter calls, and these are compared in every inner loop.
const FLUID = cellTypes.FLUID;
const SOLID = cellTypes.SOLID;
const INLET = cellTypes.INLET;
const OUTLET = cellTypes.OUTLET;

export interface SolveOptions {
  maxSteps?: number;
  /**
   * Convergence threshold on the residual: the relative velocity change per
   * flow-transit time. 0.02 means the field moves less than 2% per transit.
   */
  tolerance?: number;
  /** SOR sweeps per pressure solve */
  pressureIterations?: number;
  /** Courant number for the (unconditionally stable) advection step */
  cfl?: number;
  temperature?: number;
  /**
   * When the run goes the full `maxSteps`, return the field averaged over this
   * many final steps. Large multi-room domains keep shedding eddies instead of
   * settling, and the time-average is the meaningful steady picture there.
   */
  averageLast?: number;
  /**
   * Finish with an exact face-based projection so the returned field conserves
   * mass cell by cell (default on). See projectFaces().
   */
  exactProjection?: boolean;
  onProgress?: (fraction: number, info: { step: number; residual: number }) => void;
}

export interface SolveResult {
  u: Float32Array;
  v: Float32Array;
  w: Float32Array;
  /** Kinematic pressure (p/rho, m²/s²) relative to the domain mean */
  p: Float32Array;
  steps: number;
  residual: number;
  converged: boolean;
  dt: number;
  nuEff: number;
  /**
   * Exactly mass-conserving face velocities from the final projection (x, y, z;
   * the face on the + side of each cell), when it ran.
   */
  faces?: [Float64Array, Float64Array, Float64Array];
}

const OMEGA = 1.7; // SOR relaxation

/** Cells whose velocity the solver is free to change. */
const isSolved = (t: number) => t === FLUID;
/** Cells that carry flow (everything but solid). */
const isOpen = (t: number) => t !== SOLID;

export function solveAirflow(grid: Grid, options: SolveOptions = {}): SolveResult {
  const run = startSolve(grid, options);
  while (!run.done()) run.step();
  return run.finish();
}

/**
 * Same solve, but hands control back to the event loop every few tens of
 * milliseconds. Whole-floor runs take minutes; without yielding, the server
 * could not answer the progress polls while one is running.
 */
export async function solveAirflowAsync(grid: Grid, options: SolveOptions = {}): Promise<SolveResult> {
  const run = startSolve(grid, options);
  let lastYield = Date.now();
  while (!run.done()) {
    run.step();
    if (Date.now() - lastYield > 40) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      lastYield = Date.now();
    }
  }
  return run.finish();
}

interface SolveRun {
  done(): boolean;
  step(): void;
  finish(): SolveResult;
}

function startSolve(grid: Grid, options: SolveOptions): SolveRun {
  const { n, hx, hy, hz, type } = grid;
  const maxSteps = options.maxSteps ?? 240;
  const tolerance = options.tolerance ?? 0.005;
  const pressureIterations = options.pressureIterations ?? 24;

  const u = new Float32Array(n);
  const v = new Float32Array(n);
  const w = new Float32Array(n);
  const u0 = new Float32Array(n);
  const v0 = new Float32Array(n);
  const w0 = new Float32Array(n);
  const p = new Float32Array(n);
  const div = new Float32Array(n);

  // Reference velocity drives the time step and the eddy viscosity.
  let uRef = 0;
  for (const patch of grid.patches) {
    if (patch.velocity > uRef) uRef = patch.velocity;
  }
  if (uRef <= 0) uRef = 0.25;

  const hMin = Math.min(hx, hy, hz);
  const nuMolecular = calculateKinematicViscosity(options.temperature ?? 293.15);

  // Turbulence: the zero-equation model of Chen & Xu (1998), the standard
  // algebraic closure for indoor airflow -  nu_t = C * |V| * l, where l is the
  // distance to the nearest wall or obstruction. It reproduces the entrainment
  // and room-scale mixing that a laminar solve misses, at no extra solve cost.
  const wallDistance = computeWallDistance(grid);
  const nu = new Float32Array(n);
  nu.fill(nuMolecular);

  // Semi-Lagrangian advection is stable for CFL > 1, so march with a step well
  // above the explicit limit to reach steady state in fewer iterations.
  const cfl = options.cfl ?? 2.5;
  const dt = Math.min(cfl * (hMin / uRef), 0.5);

  // Relative change per flow-transit time, used as the convergence measure.
  const transitTime = Math.max(grid.length, grid.width, grid.height) / uRef;
  const stepsPerTransit = transitTime / dt;

  // Scratch buffer for the diffusion sweeps, allocated once.
  const scratch = new Float32Array(n);

  // Seed the field with the prescribed vent velocities.
  applyBoundaries(grid, u, v, w);

  let residual = Infinity;
  let step = 0;
  let converged = false;

  // A steady state needs the air to make several passes through the room, so
  // never declare convergence before a few transit times have been marched.
  const minSteps = Math.min(maxSteps, Math.max(40, Math.ceil(3 * stepsPerTransit)));

  const averageLast = Math.min(options.averageLast ?? 0, maxSteps);
  const sums = averageLast > 0 ? [new Float64Array(n), new Float64Array(n), new Float64Array(n)] : null;
  let averaged = 0;

  const advance = () => {
    step++;
    u0.set(u);
    v0.set(v);
    w0.set(w);

    advect(grid, u, v, w, u0, v0, w0, dt);
    applyBoundaries(grid, u, v, w);

    const nuMax = updateEddyViscosity(grid, u, v, w, nu, wallDistance, nuMolecular);
    diffuse(grid, u, v, w, nu, nuMax, dt, scratch);
    applyBoundaries(grid, u, v, w);

    computeDivergence(grid, u, v, w, div);
    solvePressure(grid, p, div, pressureIterations);
    applyPressureCorrection(grid, u, v, w, p);
    applyBoundaries(grid, u, v, w);

    // Convergence: RMS velocity change relative to the reference velocity.
    let sum = 0;
    let count = 0;
    for (let c = 0; c < n; c++) {
      if (!isSolved(type[c])) continue;
      const du = u[c] - u0[c];
      const dv = v[c] - v0[c];
      const dw = w[c] - w0[c];
      sum += du * du + dv * dv + dw * dw;
      count++;
    }
    residual = count > 0 ? (Math.sqrt(sum / count) / uRef) * stepsPerTransit : 0;

    if (options.onProgress && (step % 10 === 0 || step === maxSteps)) {
      options.onProgress(Math.min(1, step / maxSteps), { step, residual });
    }

    if (step >= minSteps && residual < tolerance) {
      converged = true;
    }

    if (sums && step > maxSteps - averageLast) {
      for (let c = 0; c < n; c++) {
        sums[0][c] += u[c];
        sums[1][c] += v[c];
        sums[2][c] += w[c];
      }
      averaged++;
    }
  };

  const finish = (): SolveResult => {
    if (sums && averaged > 0 && !converged) {
      for (let c = 0; c < n; c++) {
        u[c] = sums[0][c] / averaged;
        v[c] = sums[1][c] / averaged;
        w[c] = sums[2][c] / averaged;
      }
    }
    const faces = options.exactProjection !== false ? projectFaces(grid, u, v, w).faces : undefined;
    // Report pressure relative to the domain mean (the Neumann problem fixes it
    // only up to a constant) and convert to a kinematic pressure per unit time.
    let pSum = 0;
    let pCount = 0;
    for (let c = 0; c < n; c++) {
      if (!isOpen(type[c])) continue;
      pSum += p[c];
      pCount++;
    }
    const pMean = pCount > 0 ? pSum / pCount : 0;
    const pOut = new Float32Array(n);
    for (let c = 0; c < n; c++) {
      pOut[c] = isOpen(type[c]) ? (p[c] - pMean) / dt : 0;
    }

    // Mean eddy viscosity over the flow domain, for the run report.
    let nuSum = 0;
    let nuCount = 0;
    for (let c = 0; c < n; c++) {
      if (type[c] !== FLUID) continue;
      nuSum += nu[c];
      nuCount++;
    }

    return {
      u,
      v,
      w,
      p: pOut,
      steps: step,
      residual,
      converged,
      dt,
      nuEff: nuCount > 0 ? nuSum / nuCount : nuMolecular,
      faces,
    };
  };

  return {
    done: () => converged || step >= maxSteps,
    step: advance,
    finish,
  };
}

/**
 * Distance from each open cell to the nearest wall or obstruction face, by a
 * two-pass chamfer transform over the grid. Used as the turbulence length
 * scale; solid and out-of-domain neighbours both count as walls.
 */
function computeWallDistance(grid: Grid): Float32Array {
  const { nx, ny, nz, hx, hy, hz, type } = grid;
  const dist = new Float32Array(grid.n);
  const strideZ = nx * ny;
  const big = Math.max(grid.length, grid.width, grid.height);

  // Seed: solids are zero, open cells start at "far".
  for (let c = 0; c < grid.n; c++) {
    dist[c] = type[c] === SOLID ? 0 : big;
  }

  const relax = (c: number, nb: number, h: number) => {
    const candidate = dist[nb] + h;
    if (candidate < dist[c]) dist[c] = candidate;
  };

  for (let pass = 0; pass < 2; pass++) {
    const forward = pass === 0;
    for (let kk = 0; kk < nz; kk++) {
      const k = forward ? kk : nz - 1 - kk;
      for (let jj = 0; jj < ny; jj++) {
        const j = forward ? jj : ny - 1 - jj;
        for (let ii = 0; ii < nx; ii++) {
          const i = forward ? ii : nx - 1 - ii;
          const c = i + nx * (j + ny * k);
          if (type[c] === SOLID) continue;

          // Room walls sit half a cell outside the boundary cell centres.
          if (i === 0 || i === nx - 1) dist[c] = Math.min(dist[c], hx / 2);
          if (j === 0 || j === ny - 1) dist[c] = Math.min(dist[c], hy / 2);
          if (k === 0 || k === nz - 1) dist[c] = Math.min(dist[c], hz / 2);

          if (forward) {
            if (i > 0) relax(c, c - 1, hx);
            if (j > 0) relax(c, c - nx, hy);
            if (k > 0) relax(c, c - strideZ, hz);
          } else {
            if (i < nx - 1) relax(c, c + 1, hx);
            if (j < ny - 1) relax(c, c + nx, hy);
            if (k < nz - 1) relax(c, c + strideZ, hz);
          }
        }
      }
    }
  }

  return dist;
}

/** Chen & Xu zero-equation closure: nu_t = 0.03874 * |V| * l_wall. */
function updateEddyViscosity(
  grid: Grid,
  u: Float32Array,
  v: Float32Array,
  w: Float32Array,
  nu: Float32Array,
  wallDistance: Float32Array,
  nuMolecular: number
): number {
  const { n, type } = grid;
  let nuMax = nuMolecular;

  for (let c = 0; c < n; c++) {
    if (type[c] === SOLID) {
      nu[c] = nuMolecular;
      continue;
    }
    const speed = Math.sqrt(u[c] * u[c] + v[c] * v[c] + w[c] * w[c]);
    const value = nuMolecular + 0.03874 * speed * wallDistance[c];
    nu[c] = value;
    if (value > nuMax) nuMax = value;
  }

  return nuMax;
}

/** Pin vent cells to their prescribed velocity and solids to zero. */
function applyBoundaries(grid: Grid, u: Float32Array, v: Float32Array, w: Float32Array): void {
  const { n, type, ub, vb, wb } = grid;
  for (let c = 0; c < n; c++) {
    const t = type[c];
    if (t === SOLID) {
      u[c] = 0;
      v[c] = 0;
      w[c] = 0;
    } else if (t === INLET || t === OUTLET) {
      u[c] = ub[c];
      v[c] = vb[c];
      w[c] = wb[c];
    }
  }
}

/** Trilinear sample of a field at a physical point; solids read as zero. */
function sample(grid: Grid, f: Float32Array, x: number, y: number, z: number): number {
  const { nx, ny, nz, hx, hy, hz, type } = grid;

  // Convert to index space (cell centres sit at i + 0.5) and clamp inside.
  let gx = x / hx - 0.5;
  let gy = y / hy - 0.5;
  let gz = z / hz - 0.5;
  gx = Math.min(nx - 1.001, Math.max(0, gx));
  gy = Math.min(ny - 1.001, Math.max(0, gy));
  gz = Math.min(nz - 1.001, Math.max(0, gz));

  const i0 = Math.floor(gx);
  const j0 = Math.floor(gy);
  const k0 = Math.floor(gz);
  const i1 = Math.min(nx - 1, i0 + 1);
  const j1 = Math.min(ny - 1, j0 + 1);
  const k1 = Math.min(nz - 1, k0 + 1);
  const tx = gx - i0;
  const ty = gy - j0;
  const tz = gz - k0;

  const at = (i: number, j: number, k: number) => {
    const c = i + nx * (j + ny * k);
    return type[c] === SOLID ? 0 : f[c];
  };

  const c00 = at(i0, j0, k0) * (1 - tx) + at(i1, j0, k0) * tx;
  const c10 = at(i0, j1, k0) * (1 - tx) + at(i1, j1, k0) * tx;
  const c01 = at(i0, j0, k1) * (1 - tx) + at(i1, j0, k1) * tx;
  const c11 = at(i0, j1, k1) * (1 - tx) + at(i1, j1, k1) * tx;

  const c0 = c00 * (1 - ty) + c10 * ty;
  const c1 = c01 * (1 - ty) + c11 * ty;
  return c0 * (1 - tz) + c1 * tz;
}

function advect(
  grid: Grid,
  u: Float32Array,
  v: Float32Array,
  w: Float32Array,
  u0: Float32Array,
  v0: Float32Array,
  w0: Float32Array,
  dt: number
): void {
  const { nx, ny, nz, hx, hy, hz, type } = grid;

  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = i + nx * (j + ny * k);
        if (!isSolved(type[c])) continue;

        const x = (i + 0.5) * hx;
        const y = (j + 0.5) * hy;
        const z = (k + 0.5) * hz;

        // Midpoint backtrace: more accurate than a plain Euler step and still
        // stable for any dt.
        const xm = x - 0.5 * dt * u0[c];
        const ym = y - 0.5 * dt * v0[c];
        const zm = z - 0.5 * dt * w0[c];
        const um = sample(grid, u0, xm, ym, zm);
        const vm = sample(grid, v0, xm, ym, zm);
        const wm = sample(grid, w0, xm, ym, zm);

        const xb = x - dt * um;
        const yb = y - dt * vm;
        const zb = z - dt * wm;

        u[c] = sample(grid, u0, xb, yb, zb);
        v[c] = sample(grid, v0, xb, yb, zb);
        w[c] = sample(grid, w0, xb, yb, zb);
      }
    }
  }
}

function diffuse(
  grid: Grid,
  u: Float32Array,
  v: Float32Array,
  w: Float32Array,
  nu: Float32Array,
  nuMax: number,
  dt: number,
  scratch: Float32Array
): void {
  const { hx, hy, hz } = grid;
  const invMax = 1 / (hx * hx) + 1 / (hy * hy) + 1 / (hz * hz);
  // Explicit stability limit for the 3D Laplacian, set by the largest local
  // viscosity; the step is sub-cycled to respect it.
  const dtStable = 0.4 / (nuMax * invMax);
  const substeps = Math.max(1, Math.min(24, Math.ceil(dt / dtStable)));
  const sdt = dt / substeps;

  for (let s = 0; s < substeps; s++) {
    diffuseComponent(grid, u, nu, sdt, scratch);
    diffuseComponent(grid, v, nu, sdt, scratch);
    diffuseComponent(grid, w, nu, sdt, scratch);
  }
}

/**
 * One explicit diffusion sub-step with a spatially varying viscosity. Face
 * viscosities are the average of the two adjacent cells; walls and solids are
 * no-slip, imposed with a mirrored ghost value.
 */
function diffuseComponent(
  grid: Grid,
  f: Float32Array,
  nu: Float32Array,
  dt: number,
  scratch: Float32Array
): void {
  const { nx, ny, nz, hx, hy, hz, type } = grid;
  scratch.set(f); // read from the old state
  const strideZ = nx * ny;

  const ix = dt / (hx * hx);
  const iy = dt / (hy * hy);
  const iz = dt / (hz * hz);

  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      const rowBase = nx * (j + ny * k);
      for (let i = 0; i < nx; i++) {
        const c = rowBase + i;
        if (type[c] !== FLUID) continue;

        const fc = scratch[c];
        const nuC = nu[c];
        let delta = 0;

        // -x / +x
        delta += ix * faceDiffusion(scratch, nu, type, c, c - 1, i > 0, fc, nuC);
        delta += ix * faceDiffusion(scratch, nu, type, c, c + 1, i < nx - 1, fc, nuC);
        // -y / +y
        delta += iy * faceDiffusion(scratch, nu, type, c, c - nx, j > 0, fc, nuC);
        delta += iy * faceDiffusion(scratch, nu, type, c, c + nx, j < ny - 1, fc, nuC);
        // -z / +z
        delta += iz * faceDiffusion(scratch, nu, type, c, c - strideZ, k > 0, fc, nuC);
        delta += iz * faceDiffusion(scratch, nu, type, c, c + strideZ, k < nz - 1, fc, nuC);

        f[c] = fc + delta;
      }
    }
  }
}

function faceDiffusion(
  f: Float32Array,
  nu: Float32Array,
  type: Uint8Array,
  c: number,
  nb: number,
  inside: boolean,
  fc: number,
  nuC: number
): number {
  if (!inside || type[nb] === SOLID) {
    // No-slip wall: ghost value -fc across the face.
    return nuC * (-fc - fc);
  }
  return 0.5 * (nuC + nu[nb]) * (f[nb] - fc);
}

/** Face-flux divergence; closed faces contribute nothing. */
function computeDivergence(
  grid: Grid,
  u: Float32Array,
  v: Float32Array,
  w: Float32Array,
  div: Float32Array
): void {
  const { nx, ny, nz, hx, hy, hz, type } = grid;
  div.fill(0);

  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = i + nx * (j + ny * k);
        if (!isSolved(type[c])) continue;

        const fw = faceFlux(grid, u, i - 1, j, k, c, i > 0);
        const fe = faceFlux(grid, u, i + 1, j, k, c, i < nx - 1);
        const fs = faceFlux(grid, v, i, j - 1, k, c, j > 0);
        const fn = faceFlux(grid, v, i, j + 1, k, c, j < ny - 1);
        const fb = faceFlux(grid, w, i, j, k - 1, c, k > 0);
        const ft = faceFlux(grid, w, i, j, k + 1, c, k < nz - 1);

        div[c] = (fe - fw) / hx + (fn - fs) / hy + (ft - fb) / hz;
      }
    }
  }
}

function faceFlux(
  grid: Grid,
  f: Float32Array,
  ni: number,
  nj: number,
  nk: number,
  c: number,
  inside: boolean
): number {
  if (!inside) return 0; // room wall: no normal flow
  const nc = ni + grid.nx * (nj + grid.ny * nk);
  if (grid.type[nc] === SOLID) return 0; // obstruction face: no normal flow
  return 0.5 * (f[c] + f[nc]);
}

/**
 * SOR solve of lap(p) = div over fluid cells, Neumann everywhere (closed faces
 * and fixed-velocity vent faces are skipped). The mean divergence is removed
 * first so the pure-Neumann system is compatible.
 */
function solvePressure(grid: Grid, p: Float32Array, div: Float32Array, iterations: number): void {
  const { nx, ny, nz, hx, hy, hz, type, n } = grid;

  // Each disconnected region is its own Neumann problem, so its mean
  // divergence has to be removed separately.
  const component = grid.component;
  const regions = component ? Math.max(1, grid.componentCount ?? 1) : 1;
  const sum = new Float64Array(regions);
  const count = new Float64Array(regions);
  for (let c = 0; c < n; c++) {
    if (!isSolved(type[c])) continue;
    const r = component ? component[c] : 0;
    if (r < 0) continue;
    sum[r] += div[c];
    count[r]++;
  }
  let solvedCells = 0;
  for (let r = 0; r < regions; r++) {
    solvedCells += count[r];
    sum[r] = count[r] > 0 ? sum[r] / count[r] : 0; // now the mean
  }
  if (solvedCells === 0) return;
  // Remove the means once, up front, rather than inside the sweeps; `div` is
  // recomputed every step so it can be modified in place.
  for (let c = 0; c < n; c++) {
    if (!isSolved(type[c])) continue;
    div[c] -= component ? sum[Math.max(0, component[c])] : sum[0];
  }

  const ax = 1 / (hx * hx);
  const ay = 1 / (hy * hy);
  const az = 1 / (hz * hz);
  const strideZ = nx * ny;

  for (let it = 0; it < iterations; it++) {
    // Red-black ordering keeps the sweep direction-independent.
    for (let parity = 0; parity < 2; parity++) {
      for (let k = 0; k < nz; k++) {
        for (let j = 0; j < ny; j++) {
          const rowBase = nx * (j + ny * k);
          for (let i = (k + j + parity) % 2; i < nx; i += 2) {
            const c = rowBase + i;
            if (type[c] !== FLUID) continue;

            let numerator = 0;
            let diagonal = 0;

            if (i > 0 && type[c - 1] === FLUID) {
              numerator += ax * p[c - 1];
              diagonal += ax;
            }
            if (i < nx - 1 && type[c + 1] === FLUID) {
              numerator += ax * p[c + 1];
              diagonal += ax;
            }
            if (j > 0 && type[c - nx] === FLUID) {
              numerator += ay * p[c - nx];
              diagonal += ay;
            }
            if (j < ny - 1 && type[c + nx] === FLUID) {
              numerator += ay * p[c + nx];
              diagonal += ay;
            }
            if (k > 0 && type[c - strideZ] === FLUID) {
              numerator += az * p[c - strideZ];
              diagonal += az;
            }
            if (k < nz - 1 && type[c + strideZ] === FLUID) {
              numerator += az * p[c + strideZ];
              diagonal += az;
            }

            if (diagonal === 0) {
              p[c] = 0;
              continue;
            }

            const target = (numerator - div[c]) / diagonal;
            p[c] = p[c] + OMEGA * (target - p[c]);
          }
        }
      }
    }
  }
}

/** u -= grad(p), with closed faces mirrored so no flow is pushed into a wall. */
function applyPressureCorrection(
  grid: Grid,
  u: Float32Array,
  v: Float32Array,
  w: Float32Array,
  p: Float32Array
): void {
  const { nx, ny, nz, hx, hy, hz, type } = grid;
  const strideZ = nx * ny;

  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = i + nx * (j + ny * k);
        if (!isSolved(type[c])) continue;

        const pw = i > 0 && isSolved(type[c - 1]) ? p[c - 1] : p[c];
        const pe = i < nx - 1 && isSolved(type[c + 1]) ? p[c + 1] : p[c];
        const ps = j > 0 && isSolved(type[c - nx]) ? p[c - nx] : p[c];
        const pn = j < ny - 1 && isSolved(type[c + nx]) ? p[c + nx] : p[c];
        const pb = k > 0 && isSolved(type[c - strideZ]) ? p[c - strideZ] : p[c];
        const pt = k < nz - 1 && isSolved(type[c + strideZ]) ? p[c + strideZ] : p[c];

        u[c] -= (pe - pw) / (2 * hx);
        v[c] -= (pn - ps) / (2 * hy);
        w[c] -= (pt - pb) / (2 * hz);
      }
    }
  }
}

/** Velocity magnitude field, for post-processing. */
export function velocityMagnitude(
  grid: Grid,
  u: Float32Array,
  v: Float32Array,
  w: Float32Array
): Float32Array {
  const mag = new Float32Array(grid.n);
  for (let c = 0; c < grid.n; c++) {
    if (grid.type[c] === SOLID) continue;
    mag[c] = Math.sqrt(u[c] * u[c] + v[c] * v[c] + w[c] * w[c]);
  }
  return mag;
}

export { sample as sampleField };

/**
 * Exact mass conservation for the returned field.
 *
 * The marching scheme stores velocities at cell centres and projects with a
 * central-difference gradient, which (a known property of collocated grids)
 * never drives the face-flux divergence fully to zero: air can appear to
 * vanish inside a room. This final step works on the cell faces instead:
 *
 *   1. face flux = average of the two cells; faces touching a supply / extract
 *      cell carry that terminal's own velocity, so each terminal delivers
 *      exactly its flow; wall and solid faces carry nothing;
 *   2. solve  lap(p) = div(F)  with the compact 7-point Laplacian (Jacobi-
 *      preconditioned conjugate gradients, per connected region);
 *   3. correct F -= grad(p) on air-air faces, which makes every cell balance;
 *   4. cell velocity = mean of its two face fluxes per axis.
 *
 * Any horizontal plane through a room then carries exactly the supply that
 * crosses it, which is what particle tracks and smoke need.
 */
export function projectFaces(
  grid: Grid,
  u: Float32Array,
  v: Float32Array,
  w: Float32Array
): { iterations: number; residual: number; faces: [Float64Array, Float64Array, Float64Array] } {
  const { nx, ny, nz, hx, hy, hz, type, n } = grid;
  const plane = nx * ny;
  const strides = [1, nx, plane];
  const hs = [hx, hy, hz];
  const comps = [u, v, w];
  const dims = [nx, ny, nz];
  const coords = (c: number) => [c % nx, Math.floor(c / nx) % ny, Math.floor(c / plane)];

  // Face on the + side of each cell, per axis.
  const F = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  /** 1 where both cells are air (free face), 2 where the face is fixed by a vent, 0 closed */
  const kindOf = [new Uint8Array(n), new Uint8Array(n), new Uint8Array(n)];
  for (let c = 0; c < n; c++) {
    const ijk = coords(c);
    for (let a = 0; a < 3; a++) {
      if (ijk[a] >= dims[a] - 1) continue;
      const nb = c + strides[a];
      const tc = type[c];
      const tn = type[nb];
      if (tc === SOLID || tn === SOLID) continue;
      if (tc === FLUID && tn === FLUID) {
        F[a][c] = 0.5 * (comps[a][c] + comps[a][nb]);
        kindOf[a][c] = 1;
      } else if (tc === FLUID || tn === FLUID) {
        // Vent face: the terminal's own velocity crosses it.
        F[a][c] = tc === FLUID ? comps[a][nb] : comps[a][c];
        kindOf[a][c] = 2;
      }
    }
  }

  // Divergence of every air cell.
  const div = new Float64Array(n);
  for (let c = 0; c < n; c++) {
    if (type[c] !== FLUID) continue;
    const ijk = coords(c);
    let d = 0;
    for (let a = 0; a < 3; a++) {
      const out = F[a][c];
      const inn = ijk[a] > 0 ? F[a][c - strides[a]] : 0;
      d += (out - inn) / hs[a];
    }
    div[c] = d;
  }

  // Remove the mean per connected region so the Neumann problem is solvable.
  const comp = grid.component;
  const regions = comp ? Math.max(1, grid.componentCount ?? 1) : 1;
  const removeMean = (f: Float64Array) => {
    const sum = new Float64Array(regions);
    const cnt = new Float64Array(regions);
    for (let c = 0; c < n; c++) {
      if (type[c] !== FLUID) continue;
      const r = comp ? Math.max(0, comp[c]) : 0;
      sum[r] += f[c];
      cnt[r]++;
    }
    for (let c = 0; c < n; c++) {
      if (type[c] !== FLUID) continue;
      const r = comp ? Math.max(0, comp[c]) : 0;
      if (cnt[r] > 0) f[c] -= sum[r] / cnt[r];
    }
  };

  // A = -lap over air-air faces (SPD on mean-free vectors); solve A p = -div.
  const coef = hs.map((h) => 1 / (h * h));
  const diag = new Float64Array(n);
  for (let c = 0; c < n; c++) {
    if (type[c] !== FLUID) continue;
    const ijk = coords(c);
    let d = 0;
    for (let a = 0; a < 3; a++) {
      if (kindOf[a][c] === 1) d += coef[a];
      if (ijk[a] > 0 && kindOf[a][c - strides[a]] === 1) d += coef[a];
    }
    diag[c] = d;
  }
  const applyA = (x: Float64Array, out: Float64Array) => {
    for (let c = 0; c < n; c++) {
      if (type[c] !== FLUID) {
        out[c] = 0;
        continue;
      }
      let s = diag[c] * x[c];
      const ijk = coords(c);
      for (let a = 0; a < 3; a++) {
        if (kindOf[a][c] === 1) s -= coef[a] * x[c + strides[a]];
        if (ijk[a] > 0 && kindOf[a][c - strides[a]] === 1) s -= coef[a] * x[c - strides[a]];
      }
      out[c] = s;
    }
  };

  const b = new Float64Array(n);
  for (let c = 0; c < n; c++) b[c] = -div[c];
  removeMean(b);

  const p = new Float64Array(n);
  const r = Float64Array.from(b);
  const z = new Float64Array(n);
  const d = new Float64Array(n);
  const q = new Float64Array(n);
  const precond = (src: Float64Array, dst: Float64Array) => {
    for (let c = 0; c < n; c++) dst[c] = diag[c] > 0 ? src[c] / diag[c] : 0;
  };
  const dot = (x: Float64Array, y: Float64Array) => {
    let s = 0;
    for (let c = 0; c < n; c++) s += x[c] * y[c];
    return s;
  };
  precond(r, z);
  d.set(z);
  let rz = dot(r, z);
  const bNorm = Math.sqrt(dot(b, b)) || 1;
  let iterations = 0;
  let residual = Math.sqrt(dot(r, r)) / bNorm;
  for (; iterations < 2000 && residual > 1e-7; iterations++) {
    applyA(d, q);
    const dq = dot(d, q);
    if (dq <= 0) break;
    const alpha = rz / dq;
    for (let c = 0; c < n; c++) {
      p[c] += alpha * d[c];
      r[c] -= alpha * q[c];
    }
    precond(r, z);
    const rzNew = dot(r, z);
    const beta = rzNew / rz;
    rz = rzNew;
    for (let c = 0; c < n; c++) d[c] = z[c] + beta * d[c];
    residual = Math.sqrt(dot(r, r)) / bNorm;
  }

  // Correct the free faces, then rebuild cell-centred velocities from them.
  for (let a = 0; a < 3; a++) {
    for (let c = 0; c < n; c++) {
      if (kindOf[a][c] === 1) F[a][c] -= (p[c + strides[a]] - p[c]) / hs[a];
    }
  }
  for (let c = 0; c < n; c++) {
    if (type[c] !== FLUID) continue;
    const ijk = coords(c);
    for (let a = 0; a < 3; a++) {
      const out = F[a][c];
      const inn = ijk[a] > 0 ? F[a][c - strides[a]] : 0;
      comps[a][c] = 0.5 * (out + inn);
    }
  }
  return { iterations, residual, faces: [F[0], F[1], F[2]] };
}
