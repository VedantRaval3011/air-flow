/**
 * Smoke test: smoke released into a room is carried by the room's CFD velocity
 * field (a room study), spreads by turbulent mixing, and leaves through the
 * risers, return grilles and door gaps that actually extract from the room.
 *
 * Physics, kept deliberately simple and honest:
 *   - advection: second-order (midpoint) integration through the
 *     time-averaged CFD field, trilinearly interpolated;
 *   - turbulent dispersion: a random walk with the Chen–Xu eddy diffusivity
 *     D = 0.0387 · |V| · l (the same closure the solver uses), l ≈ 0.5 m;
 *   - glycol test smoke is taken as neutrally buoyant (no plume);
 *   - a parcel is captured when it reaches the face of an extract terminal or
 *     an outflowing door gap, and is then drawn into it.
 */

import { Facility, FacilityDoor, PlacedTerminal, VelocityField } from './types';
import { CFM_TO_M3S } from './geometry';

export type SinkKind = 'riser' | 'ceiling-return' | 'exhaust' | 'door';

export interface Sink {
  id: string;
  label: string;
  kind: SinkKind;
  /** Capture box in plan / height coordinates (m) */
  box: { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number };
  /** Direction a captured parcel is pulled (unit vector, into the grille) */
  pull: [number, number, number];
  /** Centre of the grille face, for drawing */
  face: [number, number, number];
  /** Air it extracts (m³/s), from the pressure network */
  flow: number;
}

export interface Source {
  id: string;
  /** Centre of the face and its half sizes; air leaves downward */
  x: number;
  y: number;
  z: number;
  hx: number;
  hy: number;
  /** Share of the room's supply through this terminal */
  weight: number;
}

// ============= Field sampling =============

export function solidAt(f: VelocityField, x: number, y: number, z: number): boolean {
  // Past the room's true edge (inside the last, partial block) is wall.
  if (f.extent && (x - f.x0 > f.extent[0] || y - f.y0 > f.extent[1])) return true;
  const i = Math.floor((x - f.x0) / f.h[0]);
  const j = Math.floor((y - f.y0) / f.h[1]);
  const k = Math.floor(z / f.h[2]);
  if (i < 0 || j < 0 || k < 0 || i >= f.nx || j >= f.ny || k >= f.nz) return true;
  return f.solid[i + f.nx * (j + f.ny * k)] === 1;
}

/**
 * Velocity at a point by face interpolation (Pollock's method): inside a
 * block each component varies linearly between the velocities on its own two
 * faces. The result is divergence-free inside every block and has exactly
 * zero normal velocity on walls, so tracked air never leaks through a wall or
 * accumulates in mid-air.
 */
export function velocityAt(f: VelocityField, x: number, y: number, z: number, out: number[]): void {
  const gx = Math.min(f.nx - 1e-6, Math.max(0, (x - f.x0) / f.h[0]));
  const gy = Math.min(f.ny - 1e-6, Math.max(0, (y - f.y0) / f.h[1]));
  const gz = Math.min(f.nz - 1e-6, Math.max(0, z / f.h[2]));
  const i = Math.floor(gx);
  const j = Math.floor(gy);
  const k = Math.floor(gz);
  const tx = gx - i;
  const ty = gy - j;
  const tz = gz - k;
  const ix = i + (f.nx + 1) * (j + f.ny * k);
  const iy = i + f.nx * (j + (f.ny + 1) * k);
  const iz = i + f.nx * (j + f.ny * k);
  out[0] = f.fx[ix] * (1 - tx) + f.fx[ix + 1] * tx;
  out[1] = f.fy[iy] * (1 - ty) + f.fy[iy + f.nx] * ty;
  out[2] = f.fz[iz] * (1 - tz) + f.fz[iz + f.nx * f.ny] * tz;
}

// ============= Sources and sinks =============

/** Supply terminals in the room: where the clean air enters (from the top). */
export function sourcesFor(roomId: string, terminals: PlacedTerminal[]): Source[] {
  const supply = terminals.filter((t) => t.roomId === roomId && t.role === 'supply' && t.mount === 'ceiling');
  const total = supply.reduce((a, t) => a + t.cfm, 0) || 1;
  return supply.map((t) => ({
    id: t.id,
    x: t.x,
    y: t.y,
    z: t.z - 0.06,
    hx: t.width / 2,
    hy: t.depth / 2,
    weight: t.cfm / total,
  }));
}

/**
 * Everything that takes air out of the room: its risers and ceiling returns /
 * exhausts, plus the doors the pressure model says air is leaving through.
 */
export function sinksFor(
  facility: Facility,
  roomId: string,
  terminals: PlacedTerminal[],
  doorFlowsCfm: Record<string, number>,
  doorsOpen: Record<string, boolean>,
  /** What the room actually extracts now (pressure network), to share among its grilles */
  extract: { returnCfm: number; exhaustCfm: number }
): Sink[] {
  const sinks: Sink[] = [];
  const reach = 0.25;
  const extractTerminals = terminals.filter((t) => t.roomId === roomId && t.role !== 'supply');
  const designReturn = extractTerminals.filter((t) => t.role === 'return').reduce((a, t) => a + t.cfm, 0) || 1;
  const designExhaust = extractTerminals.filter((t) => t.role === 'exhaust').reduce((a, t) => a + t.cfm, 0) || 1;
  const flowOf = (t: PlacedTerminal) =>
    (t.role === 'exhaust' ? (t.cfm / designExhaust) * extract.exhaustCfm : (t.cfm / designReturn) * extract.returnCfm) * CFM_TO_M3S;
  for (const t of extractTerminals) {
    const label = `${t.code} ${t.role === 'exhaust' ? 'exhaust' : 'return'}`;
    if (t.mount === 'ceiling') {
      sinks.push({
        id: t.id,
        label,
        kind: t.role === 'exhaust' ? 'exhaust' : 'ceiling-return',
        box: { x0: t.x - t.width / 2, x1: t.x + t.width / 2, y0: t.y - t.depth / 2, y1: t.y + t.depth / 2, z0: t.z - reach, z1: t.z + 0.1 },
        pull: [0, 0, 1],
        face: [t.x, t.y, t.z],
        flow: flowOf(t),
      });
      continue;
    }
    const n = t.normal ?? { x: 0, y: 0 };
    const alongX = n.x === 0;
    const half = t.width / 2;
    const x0 = alongX ? t.x - half : Math.min(t.x, t.x + n.x * reach) - 0.05;
    const x1 = alongX ? t.x + half : Math.max(t.x, t.x + n.x * reach) + 0.05;
    const y0 = alongX ? Math.min(t.y, t.y + n.y * reach) - 0.05 : t.y - half;
    const y1 = alongX ? Math.max(t.y, t.y + n.y * reach) + 0.05 : t.y + half;
    sinks.push({
      id: t.id,
      label: t.code.startsWith('R') ? `Riser ${t.code}, ${wallName(n)} wall` : label,
      kind: t.code.startsWith('R') ? 'riser' : t.role === 'exhaust' ? 'exhaust' : 'ceiling-return',
      // A riser draws in the air from the floor up to just above its grille;
      // the 20 cm field puts the converging flow anywhere in that band.
      box: {
        x0,
        x1,
        y0,
        y1,
        z0: t.code.startsWith('R') ? 0 : t.z - t.depth / 2 - 0.05,
        z1: t.z + t.depth / 2 + (t.code.startsWith('R') ? 0.25 : 0.05),
      },
      pull: [-n.x, -n.y, 0],
      face: [t.x, t.y, t.z],
      flow: flowOf(t),
    });
  }

  const room = facility.rooms.find((r) => r.id === roomId);
  for (const d of facility.doors) {
    if (!room || !d.rooms.includes(roomId)) continue;
    const flow = doorFlowsCfm[d.id] ?? 0;
    const out = d.rooms[0] === roomId ? flow : -flow;
    if (out <= 1) continue; // air comes in (or nothing moves) through this door
    const inward = inwardAt(room.rects, d);
    const gap = doorsOpen[d.id] ? d.height : 0.25;
    const across = 0.15;
    sinks.push({
      id: `door:${d.id}`,
      label: `Door gap → ${d.rooms[0] === roomId ? d.rooms[1] ?? 'outside' : d.rooms[0]}`,
      kind: 'door',
      box:
        d.axis === 'x'
          ? { x0: d.x - d.width / 2, x1: d.x + d.width / 2, y0: d.y - across, y1: d.y + across, z0: 0, z1: gap }
          : { x0: d.x - across, x1: d.x + across, y0: d.y - d.width / 2, y1: d.y + d.width / 2, z0: 0, z1: gap },
      pull: [-inward.x, -inward.y, 0],
      face: [d.x, d.y, gap / 2],
      flow: out * CFM_TO_M3S,
    });
  }
  // Several grilles of the same type on one wall: number them so each is
  // named uniquely ("Riser R3, south wall 1 / 2").
  const total = new Map<string, number>();
  for (const s of sinks) total.set(s.label, (total.get(s.label) ?? 0) + 1);
  const seen = new Map<string, number>();
  for (const s of sinks) {
    const n = total.get(s.label) ?? 1;
    if (n < 2) continue;
    const k = (seen.get(s.label) ?? 0) + 1;
    seen.set(s.label, k);
    s.label = `${s.label} ${k} / ${n}`;
  }
  return sinks;
}

/** Which wall a grille is on, from its inward normal (plan up = north). */
function wallName(n: { x: number; y: number }): string {
  if (n.y > 0.5) return 'north';
  if (n.y < -0.5) return 'south';
  if (n.x > 0.5) return 'west';
  return 'east';
}

function inwardAt(rects: { x0: number; y0: number; x1: number; y1: number }[], d: FacilityDoor): { x: number; y: number } {
  const inside = (x: number, y: number) => rects.some((r) => x > r.x0 && x < r.x1 && y > r.y0 && y < r.y1);
  if (d.axis === 'x') return inside(d.x, d.y + 0.2) ? { x: 0, y: 1 } : { x: 0, y: -1 };
  return inside(d.x + 0.2, d.y) ? { x: 1, y: 0 } : { x: -1, y: 0 };
}

/** Lower a release point until it sits in air (terminal faces are on block edges). */
export function intoAir(field: VelocityField, x: number, y: number, z: number): number {
  let zz = z;
  for (let k = 0; k < 6 && solidAt(field, x, y, zz); k++) zz -= field.h[2] / 2;
  return zz;
}

// ============= Parcels =============

export const enum ParcelState {
  Free = 0,
  Moving = 1,
  Captured = 2,
}

/**
 * A fixed pool of parcels (smoke puffs or tracer balls), updated in place so
 * the animation allocates nothing per frame.
 */
export class ParcelPool {
  readonly n: number;
  readonly pos: Float32Array;
  readonly age: Float32Array;
  readonly life: Float32Array;
  readonly state: Uint8Array;
  /** Time spent being drawn into a sink */
  readonly exitT: Float32Array;
  readonly sink: Int16Array;
  private cursor = 0;

  constructor(n: number) {
    this.n = n;
    this.pos = new Float32Array(n * 3);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n);
    this.state = new Uint8Array(n);
    this.exitT = new Float32Array(n);
    this.sink = new Int16Array(n).fill(-1);
  }

  /**
   * Use the next free slot. When every slot is in use nothing is released:
   * a parcel still in the room is never recycled, so everything that enters
   * leaves only through the suction.
   */
  spawn(x: number, y: number, z: number, life: number): number {
    for (let tries = 0; tries < this.n; tries++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.n;
      if (this.state[i] === ParcelState.Free) {
        this.pos[i * 3] = x;
        this.pos[i * 3 + 1] = y;
        this.pos[i * 3 + 2] = z;
        this.age[i] = 0;
        this.life[i] = life;
        this.state[i] = ParcelState.Moving;
        this.exitT[i] = 0;
        this.sink[i] = -1;
        return i;
      }
    }
    return -1;
  }

  clear(): void {
    this.state.fill(ParcelState.Free);
  }
}

export interface SmokeCounters {
  released: number;
  /** Captured per sink id */
  captured: Record<string, number>;
  /** Parcels that timed out still inside the room (lingering smoke) */
  lingered: number;
  /** Seconds from release to capture, for the parcels captured */
  residence: number[];
}

export function newCounters(): SmokeCounters {
  return { released: 0, captured: {}, lingered: 0, residence: [] };
}

const EDDY = 0.0387; // Chen–Xu coefficient

/** Turbulent dispersion: D = max(minDiffusivity, 0.0387·|V|·mixingLength). */
export interface Dispersion {
  mixingLength: number; // m
  minDiffusivity: number; // m²/s
}
export const DEFAULT_DISPERSION: Dispersion = { mixingLength: 0.5, minDiffusivity: 2e-4 };
/**
 * Within this distance of a grille the ~20 cm field cannot resolve the
 * converging flow, so the analytic near field of a sink on a wall,
 * v = Q / (2π r²), is blended in (the capture-velocity model used for
 * extract hoods).
 */
const NEAR_FIELD = 0.6; // m
const MIN_SINK_RADIUS = 0.12; // m, about the grille half-size
const CAPTURE_TIME = 0.45; // s spent visibly entering the grille

/**
 * Advance every moving parcel by dt: midpoint advection through the field, a
 * turbulent random-walk step, then capture by sinks. Parcels never step into
 * solid blocks (walls, equipment); they slide along them instead.
 */
export function stepParcels(
  pool: ParcelPool,
  dt: number,
  field: VelocityField,
  sinks: Sink[],
  bounds: { height: number },
  counters: SmokeCounters,
  random: () => number = Math.random,
  dispersion: Dispersion = DEFAULT_DISPERSION
): void {
  const v = [0, 0, 0];
  const m = [0, 0, 0];
  for (let i = 0; i < pool.n; i++) {
    const st = pool.state[i];
    if (st === ParcelState.Free) continue;
    pool.age[i] += dt;
    const o = i * 3;

    if (st === ParcelState.Captured) {
      // Drawn into the grille, then gone.
      const s = sinks[pool.sink[i]];
      pool.exitT[i] += dt;
      if (s) {
        pool.pos[o] += s.pull[0] * 0.8 * dt;
        pool.pos[o + 1] += s.pull[1] * 0.8 * dt;
        pool.pos[o + 2] += s.pull[2] * 0.8 * dt;
      }
      if (pool.exitT[i] > CAPTURE_TIME) pool.state[i] = ParcelState.Free;
      continue;
    }

    if (pool.age[i] > pool.life[i]) {
      counters.lingered++;
      pool.state[i] = ParcelState.Free;
      continue;
    }

    const x = pool.pos[o];
    const y = pool.pos[o + 1];
    const z = pool.pos[o + 2];
    velocityAt(field, x, y, z, v);
    addSinks(sinks, x, y, z, v);
    const mx = x + 0.5 * dt * v[0];
    const my = y + 0.5 * dt * v[1];
    const mz = z + 0.5 * dt * v[2];
    velocityAt(field, mx, my, mz, m);
    addSinks(sinks, mx, my, mz, m);
    const speed = Math.hypot(m[0], m[1], m[2]);
    // Turbulent dispersion: σ = sqrt(2 D dt) per axis, D from the eddy viscosity.
    const sigma = Math.sqrt(2 * Math.max(dispersion.minDiffusivity, EDDY * speed * dispersion.mixingLength) * dt);
    const nx = x + m[0] * dt + sigma * gauss(random);
    const ny = y + m[1] * dt + sigma * gauss(random);
    const nz = Math.min(bounds.height - 0.02, Math.max(0.02, z + m[2] * dt + sigma * gauss(random)));

    // Slide along solids axis by axis rather than passing through them; a
    // parcel that is already inside a solid block (a face on a block edge) is
    // always let out.
    const trapped = solidAt(field, x, y, z);
    if (trapped || !solidAt(field, nx, y, z)) pool.pos[o] = nx;
    if (trapped || !solidAt(field, pool.pos[o], ny, z)) pool.pos[o + 1] = ny;
    if (trapped || !solidAt(field, pool.pos[o], pool.pos[o + 1], nz)) pool.pos[o + 2] = nz;

    const px = pool.pos[o];
    const py = pool.pos[o + 1];
    const pz = pool.pos[o + 2];
    for (let s = 0; s < sinks.length; s++) {
      const b = sinks[s].box;
      if (px >= b.x0 && px <= b.x1 && py >= b.y0 && py <= b.y1 && pz >= b.z0 && pz <= b.z1) {
        pool.state[i] = ParcelState.Captured;
        pool.sink[i] = s;
        pool.exitT[i] = 0;
        counters.captured[sinks[s].id] = (counters.captured[sinks[s].id] ?? 0) + 1;
        counters.residence.push(pool.age[i]);
        if (counters.residence.length > 4000) counters.residence.splice(0, 1000);
        break;
      }
    }
  }
}

/** Near-field suction of every extract terminal, faded out by NEAR_FIELD. */
function addSinks(sinks: Sink[], x: number, y: number, z: number, out: number[]): void {
  for (const s of sinks) {
    const dx = s.face[0] - x;
    const dy = s.face[1] - y;
    const dz = s.face[2] - z;
    const r = Math.hypot(dx, dy, dz);
    if (r >= NEAR_FIELD || s.flow <= 0) continue;
    const rr = Math.max(r, MIN_SINK_RADIUS);
    const fade = 1 - r / NEAR_FIELD;
    const speed = (s.flow / (2 * Math.PI * rr * rr)) * fade * fade;
    const inv = 1 / Math.max(r, 1e-6);
    out[0] += dx * inv * speed;
    out[1] += dy * inv * speed;
    out[2] += dz * inv * speed;
  }
}

function gauss(random: () => number): number {
  // Box–Muller
  const u = Math.max(1e-9, random());
  const w = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * w);
}

// ============= Operator =============

export interface OperatorSpot {
  x: number;
  y: number;
  /** three.js yaw so the operator faces the chosen supply terminal */
  yaw: number;
  /** Plan position the wand reaches up to (under that terminal) */
  target: { x: number; y: number };
}

/**
 * Where the smoke-test operator stands: a pace from the room's main supply
 * terminal, on the side towards the middle of the room, facing it — so the
 * raised wand puts smoke straight into the supply air.
 */
export function operatorSpot(facility: Facility, roomId: string, sources: Source[]): OperatorSpot {
  const room = facility.rooms.find((r) => r.id === roomId);
  const rects = room?.rects ?? [];
  const main = rects.reduce(
    (best, q) => ((q.x1 - q.x0) * (q.y1 - q.y0) > (best.x1 - best.x0) * (best.y1 - best.y0) ? q : best),
    rects[0] ?? { x0: 0, y0: 0, x1: 1, y1: 1 }
  );
  const cx = (main.x0 + main.x1) / 2;
  const cy = (main.y0 + main.y1) / 2;
  const src = sources.reduce<Source | null>((best, s) => (!best || s.weight > best.weight ? s : best), null);
  const target = src ? { x: src.x, y: src.y } : { x: cx, y: cy };

  let dx = cx - target.x;
  let dy = cy - target.y;
  const len = Math.hypot(dx, dy);
  if (len < 0.2) {
    // Terminal at the room centre: stand along the room's longer axis.
    dx = main.x1 - main.x0 >= main.y1 - main.y0 ? 1 : 0;
    dy = dx ? 0 : 1;
  } else {
    dx /= len;
    dy /= len;
  }
  const reach = 0.8;
  const margin = 0.45;
  const x = Math.min(main.x1 - margin, Math.max(main.x0 + margin, target.x + dx * reach));
  const y = Math.min(main.y1 - margin, Math.max(main.y0 + margin, target.y + dy * reach));
  // three.js: local +z faces the target; plan y maps to three z.
  const yaw = Math.atan2(target.x - x, target.y - y);
  return { x, y, yaw, target };
}

// ============= Air paths =============

export interface AirPath {
  sourceId: string;
  /** Index into the sinks it ends in, or -1 if it keeps circulating */
  sink: number;
  /** Plan x, y, z per point */
  points: number[];
  speeds: number[];
  /** Share of the room's supply this path represents */
  share: number;
  length: number;
  meanSpeed: number;
}

/**
 * Representative paths of the room's air: seeds spread over every supply face,
 * each followed through the mean flow (same face-interpolated field and grille
 * near-field as the smoke) until it enters a suction. Each path stands for an
 * equal slice of its terminal's air, so counting paths per suction gives the
 * share of the room's air each one takes.
 */
export function traceAirPaths(field: VelocityField, sources: Source[], sinks: Sink[], roomHeight: number): AirPath[] {
  const paths: AirPath[] = [];
  const v = [0, 0, 0];
  const m = [0, 0, 0];
  const step = 0.04; // m of path per integration step
  const inside = (x: number, y: number, z: number, b: Sink['box']) =>
    x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1 && z >= b.z0 && z <= b.z1;

  for (const src of sources) {
    const nx = Math.max(2, Math.min(4, Math.round((2 * src.hx) / 0.2)));
    const ny = Math.max(2, Math.min(3, Math.round((2 * src.hy) / 0.2)));
    for (let a = 0; a < nx; a++) {
      for (let b = 0; b < ny; b++) {
        let x = src.x + (((a + 0.5) / nx) * 2 - 1) * src.hx * 0.8;
        let y = src.y + (((b + 0.5) / ny) * 2 - 1) * src.hy * 0.8;
        let z = intoAir(field, x, y, src.z);
        const points = [x, y, z];
        const speeds: number[] = [];
        let sink = -1;
        let slow = 0;
        let length = 0;
        for (let k = 0; k < 2500 && sink < 0; k++) {
          velocityAt(field, x, y, z, v);
          addSinks(sinks, x, y, z, v);
          const s0 = Math.hypot(v[0], v[1], v[2]);
          if (s0 < 1e-5) break;
          const dt = step / s0;
          const mx = x + 0.5 * dt * v[0];
          const my = y + 0.5 * dt * v[1];
          const mz = z + 0.5 * dt * v[2];
          velocityAt(field, mx, my, mz, m);
          addSinks(sinks, mx, my, mz, m);
          let nx2 = x + dt * m[0];
          let ny2 = y + dt * m[1];
          let nz2 = Math.min(roomHeight - 0.02, Math.max(0.02, z + dt * m[2]));
          // Air meeting a wall runs along it: drop the component into the wall.
          if (solidAt(field, nx2, ny2, nz2)) {
            if (!solidAt(field, x, ny2, nz2)) nx2 = x;
            else if (!solidAt(field, nx2, y, nz2)) ny2 = y;
            else if (!solidAt(field, nx2, ny2, z)) nz2 = z;
            else break;
          }
          length += Math.hypot(nx2 - x, ny2 - y, nz2 - z);
          x = nx2;
          y = ny2;
          z = nz2;
          const sp = Math.hypot(m[0], m[1], m[2]);
          speeds.push(sp);
          points.push(x, y, z);
          slow = sp < 0.004 ? slow + 1 : 0;
          if (slow > 60) break;
          for (let si = 0; si < sinks.length; si++) {
            if (inside(x, y, z, sinks[si].box)) {
              sink = si;
              const f = sinks[si].face;
              points.push(f[0], f[1], f[2]);
              speeds.push(sp);
              break;
            }
          }
        }
        speeds.unshift(speeds[0] ?? 0);
        paths.push({
          sourceId: src.id,
          sink,
          points,
          speeds,
          share: src.weight / (nx * ny),
          length,
          meanSpeed: speeds.reduce((acc, q) => acc + q, 0) / Math.max(1, speeds.length),
        });
      }
    }
  }
  return paths;
}

/** Share of the room's supply that ends in each sink (index), and the rest. */
export function pathShares(paths: AirPath[], sinks: Sink[]): { perSink: number[]; circulating: number } {
  const perSink = sinks.map(() => 0);
  let circulating = 0;
  for (const p of paths) {
    if (p.sink >= 0) perSink[p.sink] += p.share;
    else circulating += p.share;
  }
  return { perSink, circulating };
}
