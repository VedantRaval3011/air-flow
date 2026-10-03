/**
 * Cartesian grid builder for the built-in airflow solver.
 *
 * The room occupies x in [0, length], y in [0, width], z in [0, height],
 * matching the convention used by the editor and the OpenFOAM case files
 * (z is up, obstruction positions are centred in x/y with z at the base).
 *
 * Every cell is classified once, up front:
 *   FLUID  - solved for
 *   SOLID  - obstruction or outside the flow domain (no-slip, zero velocity)
 *   INLET  - supply diffuser cell, velocity prescribed
 *   OUTLET - return grill cell, velocity prescribed so that mass balances
 */

import { IRoomDocument } from '@/db/models/Room';
import { IConfigurationDocument } from '@/db/models/Configuration';
import { IObstruction, IReturnGrill, ISupplyDiffuser, Vector3D } from '@/types';
import { calculateDiffuserVelocity, calculateRequiredFlowRate } from '@/lib/physics/airflowCalculations';

export const FLUID = 0;
export const SOLID = 1;
export const INLET = 2;
export const OUTLET = 3;

export interface VentPatch {
  id: string;
  kind: 'inlet' | 'outlet';
  /** Unit vector pointing into the room from the surface the vent sits on */
  inward: Vector3D;
  /** Cell indices belonging to this patch */
  cells: number[];
  /** Discrete open area of the patch (m²) */
  area: number;
  /** Normal velocity magnitude (m/s), always positive */
  velocity: number;
  /**
   * Per-cell discharge direction (x, y, z per cell, unit length) when it is
   * not simply `inward`, e.g. the radial throw of a 4-way ceiling diffuser.
   */
  cellDirs?: number[];
}

export interface Grid {
  nx: number;
  ny: number;
  nz: number;
  n: number;
  hx: number;
  hy: number;
  hz: number;
  length: number;
  width: number;
  height: number;
  /** Cell classification, length n */
  type: Uint8Array;
  /** Prescribed velocity for INLET/OUTLET cells, zero elsewhere */
  ub: Float32Array;
  vb: Float32Array;
  wb: Float32Array;
  patches: VentPatch[];
  /** Volumetric supply flow actually imposed (m³/s) */
  supplyFlow: number;
  /**
   * Connected flow region of each cell (-1 for solids). Set for multi-room
   * grids, where closed-off rooms must each conserve mass on their own; when
   * absent the whole domain is treated as one region.
   */
  component?: Int32Array;
  componentCount?: number;
}

export interface GridOptions {
  /** Preferred cell size in metres */
  targetCellSize?: number;
  /** Hard cap on total cell count (keeps runtime bounded) */
  maxCells?: number;
}

export const idx = (g: Grid, i: number, j: number, k: number): number =>
  i + g.nx * (j + g.ny * k);

export const cellCenter = (g: Grid, i: number, j: number, k: number): Vector3D => ({
  x: (i + 0.5) * g.hx,
  y: (j + 0.5) * g.hy,
  z: (k + 0.5) * g.hz,
});

/** Which of the six room surfaces a vent is mounted on. */
function ventFace(
  pos: Vector3D,
  room: { length: number; width: number; height: number }
): { axis: 'x' | 'y' | 'z'; side: 0 | 1 } {
  const candidates: Array<{ axis: 'x' | 'y' | 'z'; side: 0 | 1; dist: number }> = [
    { axis: 'x', side: 0, dist: Math.abs(pos.x) },
    { axis: 'x', side: 1, dist: Math.abs(room.length - pos.x) },
    { axis: 'y', side: 0, dist: Math.abs(pos.y) },
    { axis: 'y', side: 1, dist: Math.abs(room.width - pos.y) },
    { axis: 'z', side: 0, dist: Math.abs(pos.z) },
    { axis: 'z', side: 1, dist: Math.abs(room.height - pos.z) },
  ];
  candidates.sort((a, b) => a.dist - b.dist);
  return { axis: candidates[0].axis, side: candidates[0].side };
}

function inwardNormal(axis: 'x' | 'y' | 'z', side: 0 | 1): Vector3D {
  const s = side === 0 ? 1 : -1;
  if (axis === 'x') return { x: s, y: 0, z: 0 };
  if (axis === 'y') return { x: 0, y: s, z: 0 };
  return { x: 0, y: 0, z: s };
}

/** 1D overlap length between [a0,a1] and [b0,b1]. */
function overlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

/**
 * Collect the boundary-layer cells covered by a vent footprint. A cell belongs
 * to the patch when the vent covers at least half of its face, which keeps the
 * discrete area close to the nominal one instead of rounding outwards.
 * Falls back to the single closest cell when the vent is smaller than a cell.
 */
function patchCells(
  g: Grid,
  pos: Vector3D,
  size: { width: number; height: number },
  axis: 'x' | 'y' | 'z',
  side: 0 | 1
): { cells: number[]; area: number } {
  const halfW = Math.max(size.width, 0) / 2;
  const halfH = Math.max(size.height, 0) / 2;

  // In-plane axes: "width" runs along the first, "height" along the second.
  // For a wall that means horizontal x/y and vertical z; for floor/ceiling x and y.
  const plane =
    axis === 'x'
      ? { n1: g.ny, h1: g.hy, c1: pos.y, n2: g.nz, h2: g.hz, c2: pos.z }
      : axis === 'y'
        ? { n1: g.nx, h1: g.hx, c1: pos.x, n2: g.nz, h2: g.hz, c2: pos.z }
        : { n1: g.nx, h1: g.hx, c1: pos.x, n2: g.ny, h2: g.hy, c2: pos.y };

  const faceArea = plane.h1 * plane.h2;
  const v1 = { lo: plane.c1 - halfW, hi: plane.c1 + halfW };
  const v2 = { lo: plane.c2 - halfH, hi: plane.c2 + halfH };

  const flatten = (a: number, b: number): number => {
    if (axis === 'x') return idx(g, side === 0 ? 0 : g.nx - 1, a, b);
    if (axis === 'y') return idx(g, a, side === 0 ? 0 : g.ny - 1, b);
    return idx(g, a, b, side === 0 ? 0 : g.nz - 1);
  };

  const cells: number[] = [];
  let bestIndex = -1;
  let bestOverlap = -1;

  for (let b = 0; b < plane.n2; b++) {
    for (let a = 0; a < plane.n1; a++) {
      const o1 = overlap(a * plane.h1, (a + 1) * plane.h1, v1.lo, v1.hi);
      const o2 = overlap(b * plane.h2, (b + 1) * plane.h2, v2.lo, v2.hi);
      const covered = o1 * o2;
      const cell = flatten(a, b);

      if (covered > bestOverlap) {
        bestOverlap = covered;
        bestIndex = cell;
      }
      if (covered >= 0.5 * faceArea) cells.push(cell);
    }
  }

  // Vent smaller than one cell: keep the best-covered cell so it still flows.
  if (cells.length === 0 && bestIndex >= 0) cells.push(bestIndex);

  return { cells, area: cells.length * faceArea };
}

/** Inlet velocity for a diffuser, with an ACH-based fallback when unset. */
function diffuserVelocity(
  diffuser: ISupplyDiffuser,
  fallbackVelocity: number
): number {
  const stored = diffuser.calculatedVelocity ?? 0;
  const velocity = stored > 0 ? stored : calculateDiffuserVelocity(diffuser);
  return velocity > 0 ? velocity : fallbackVelocity;
}

function markObstruction(g: Grid, obs: IObstruction): void {
  const pos = obs.position;

  if (obs.shape === 'cylinder' || obs.type === 'human') {
    const radius = obs.radius ?? 0.25;
    const height =
      obs.height ?? (obs.humanPosture === 'sitting' ? 1.2 : obs.humanPosture === 'working' ? 1.5 : 1.7);
    const r2 = radius * radius;
    for (let k = 0; k < g.nz; k++) {
      for (let j = 0; j < g.ny; j++) {
        for (let i = 0; i < g.nx; i++) {
          const c = cellCenter(g, i, j, k);
          if (c.z < pos.z || c.z > pos.z + height) continue;
          const dx = c.x - pos.x;
          const dy = c.y - pos.y;
          if (dx * dx + dy * dy <= r2) setSolid(g, idx(g, i, j, k));
        }
      }
    }
    return;
  }

  const w = obs.dimensions?.width ?? 1;
  const d = obs.dimensions?.depth ?? 1;
  const h = obs.dimensions?.height ?? 1;
  for (let k = 0; k < g.nz; k++) {
    for (let j = 0; j < g.ny; j++) {
      for (let i = 0; i < g.nx; i++) {
        const c = cellCenter(g, i, j, k);
        if (
          Math.abs(c.x - pos.x) <= w / 2 &&
          Math.abs(c.y - pos.y) <= d / 2 &&
          c.z >= pos.z &&
          c.z <= pos.z + h
        ) {
          setSolid(g, idx(g, i, j, k));
        }
      }
    }
  }
}

/** Solid wins over fluid but never overwrites a vent cell. */
function setSolid(g: Grid, c: number): void {
  if (g.type[c] === INLET || g.type[c] === OUTLET) return;
  g.type[c] = SOLID;
}

export function buildGrid(
  room: IRoomDocument,
  config: IConfigurationDocument,
  options: GridOptions = {}
): Grid {
  const { length, width, height } = room.dimensions;
  const maxCells = options.maxCells ?? 40000;

  // Start from the preferred cell size and coarsen uniformly until the cell
  // budget is met, so the solve stays interactive for large rooms.
  let h = options.targetCellSize ?? 0.2;
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let attempt = 0; attempt < 40; attempt++) {
    nx = Math.max(4, Math.round(length / h));
    ny = Math.max(4, Math.round(width / h));
    nz = Math.max(4, Math.round(height / h));
    if (nx * ny * nz <= maxCells) break;
    h *= Math.cbrt((nx * ny * nz) / maxCells) * 1.02;
  }

  const g: Grid = {
    nx,
    ny,
    nz,
    n: nx * ny * nz,
    hx: length / nx,
    hy: width / ny,
    hz: height / nz,
    length,
    width,
    height,
    type: new Uint8Array(nx * ny * nz), // FLUID = 0
    ub: new Float32Array(nx * ny * nz),
    vb: new Float32Array(nx * ny * nz),
    wb: new Float32Array(nx * ny * nz),
    patches: [],
    supplyFlow: 0,
  };

  for (const obs of config.obstructions ?? []) {
    markObstruction(g, obs);
  }

  // --- Supply diffusers -----------------------------------------------------
  const diffusers: ISupplyDiffuser[] = config.supplyDiffusers ?? [];
  const targetACH = config.airflowParams?.targetACH ?? 0;
  const requiredFlow = targetACH > 0 ? calculateRequiredFlowRate(targetACH, room.dimensions) : 0;
  const totalVentArea = diffusers.reduce(
    (sum, d) => sum + Math.max(d.size?.width ?? 0, 0) * Math.max(d.size?.height ?? 0, 0),
    0
  );
  // Used only when a diffuser has neither a flow rate nor an RPM configured.
  const fallbackVelocity =
    totalVentArea > 0 && requiredFlow > 0 ? requiredFlow / totalVentArea : 0.45;

  for (const diffuser of diffusers) {
    const face = ventFace(diffuser.position, room.dimensions);
    const { cells, area } = patchCells(g, diffuser.position, diffuser.size, face.axis, face.side);
    const inward = inwardNormal(face.axis, face.side);
    const velocity = diffuserVelocity(diffuser, fallbackVelocity);

    // The vent footprint has to snap to whole cells, so its discrete area
    // differs a little from the nominal one. Scale the imposed velocity to keep
    // the volumetric flow (and therefore the ACH) faithful to the
    // configuration - flow rate matters more here than peak jet speed.
    const nominalArea = Math.max(diffuser.size?.width ?? 0, 0) * Math.max(diffuser.size?.height ?? 0, 0);
    const flow = velocity * (nominalArea > 0 ? nominalArea : area);
    const cellVelocity = area > 0 ? flow / area : 0;

    for (const c of cells) {
      g.type[c] = INLET;
      g.ub[c] = inward.x * cellVelocity;
      g.vb[c] = inward.y * cellVelocity;
      g.wb[c] = inward.z * cellVelocity;
    }

    g.patches.push({
      id: diffuser.id,
      kind: 'inlet',
      inward,
      cells,
      area,
      velocity: cellVelocity,
    });
    g.supplyFlow += cellVelocity * area;
  }

  // --- Return grills --------------------------------------------------------
  const grills: IReturnGrill[] = config.returnGrills ?? [];
  const outletPatches: VentPatch[] = [];
  let outletArea = 0;

  for (const grill of grills) {
    const face = ventFace(grill.position, room.dimensions);
    const { cells, area } = patchCells(g, grill.position, grill.size, face.axis, face.side);
    const inward = inwardNormal(face.axis, face.side);
    for (const c of cells) {
      g.type[c] = OUTLET;
    }
    const patch: VentPatch = { id: grill.id, kind: 'outlet', inward, cells, area, velocity: 0 };
    outletPatches.push(patch);
    outletArea += area;
  }

  // Extraction velocity is set from the supply flow so the discrete problem is
  // mass-conserving: what is pushed in is pulled out.
  const outletVelocity = outletArea > 0 ? g.supplyFlow / outletArea : 0;
  for (const patch of outletPatches) {
    patch.velocity = outletVelocity;
    for (const c of patch.cells) {
      g.ub[c] = -patch.inward.x * outletVelocity;
      g.vb[c] = -patch.inward.y * outletVelocity;
      g.wb[c] = -patch.inward.z * outletVelocity;
    }
    g.patches.push(patch);
  }

  return g;
}
