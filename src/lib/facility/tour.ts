/**
 * First-person walk-through of the facility: collision against the walls and
 * shut doors, spawn points inside rooms, and reading the airflow at the
 * walker's position from the CFD results.
 */

import { Facility, FacilityDoor, FacilityObject, FacilityResults, PlanRect } from './types';
import { WallSegment, doorsOnWall, roomAt } from './geometry';

export const EYE_HEIGHT = 1.6;
export const PLAYER_RADIUS = 0.22;
export const WALK_SPEED = 1.4; // m/s
export const RUN_SPEED = 3.0;

/**
 * Solid footprints the walker cannot pass: every wall, with gaps only where a
 * door is open. Exterior doors always stay shut so the tour stays indoors.
 */
export function collisionRects(
  facility: Facility,
  walls: WallSegment[],
  doorsOpen: Record<string, boolean>,
  /** Equipment, benches and people also block the walker */
  objects: FacilityObject[] = []
): PlanRect[] {
  const half = 0.06;
  const rects: PlanRect[] = [];
  for (const w of walls) {
    let pieces = [{ from: w.from, to: w.to }];
    for (const d of doorsOnWall(w, facility.doors)) {
      if (d.rooms[1] === null || !doorsOpen[d.id]) continue;
      const c = w.axis === 'x' ? d.x : d.y;
      const d0 = c - d.width / 2;
      const d1 = c + d.width / 2;
      pieces = pieces.flatMap((p) =>
        d1 <= p.from || d0 >= p.to ? [p] : [{ from: p.from, to: Math.max(p.from, d0) }, { from: Math.min(p.to, d1), to: p.to }]
      );
    }
    for (const p of pieces) {
      if (p.to - p.from < 1e-3) continue;
      rects.push(
        w.axis === 'x'
          ? { x0: p.from - half, x1: p.to + half, y0: w.at - half, y1: w.at + half }
          : { x0: w.at - half, x1: w.at + half, y0: p.from - half, y1: p.to + half }
      );
    }
  }
  for (const o of objects) {
    rects.push({ x0: o.x - o.width / 2, x1: o.x + o.width / 2, y0: o.y - o.depth / 2, y1: o.y + o.depth / 2 });
  }
  return rects;
}

export function blocked(facility: Facility, rects: PlanRect[], x: number, y: number, r = PLAYER_RADIUS): boolean {
  if (!roomAt(facility, x, y)) return true;
  for (const q of rects) {
    if (x > q.x0 - r && x < q.x1 + r && y > q.y0 - r && y < q.y1 + r) return true;
  }
  return false;
}

export interface Spawn {
  x: number;
  y: number;
  /** Camera yaw (radians about the vertical axis; 0 looks towards -y on the plan) */
  yaw: number;
}

/** Stand near one end of the room's largest rect, looking down its length. */
export function spawnFor(facility: Facility, roomId: string): Spawn | null {
  const room = facility.rooms.find((r) => r.id === roomId);
  if (!room) return null;
  const r = room.rects.reduce((best, q) =>
    (q.x1 - q.x0) * (q.y1 - q.y0) > (best.x1 - best.x0) * (best.y1 - best.y0) ? q : best
  );
  const cx = (r.x0 + r.x1) / 2;
  const cy = (r.y0 + r.y1) / 2;
  const alongX = r.x1 - r.x0 >= r.y1 - r.y0;
  const back = Math.max(0, (alongX ? r.x1 - r.x0 : r.y1 - r.y0) / 2 - 0.7);
  // three.js cameras look down -z; yaw -π/2 faces +x, yaw π faces +y (plan).
  return alongX ? { x: cx - back, y: cy, yaw: -Math.PI / 2 } : { x: cx, y: cy - back, yaw: Math.PI };
}

/** Closest interior door within reach, for the "open / close door" action. */
export function nearestDoor(facility: Facility, x: number, y: number, reach = 1.5): FacilityDoor | null {
  let best: FacilityDoor | null = null;
  let bestDist = reach;
  for (const d of facility.doors) {
    if (d.rooms[1] === null) continue;
    const dist = Math.hypot(d.x - x, d.y - y);
    if (dist < bestDist) {
      bestDist = dist;
      best = d;
    }
  }
  return best;
}

export interface LocalAir {
  speed: number;
  /** Unit direction in plan coordinates (x, y) and vertical (z) */
  dir: [number, number, number];
  distance: number;
}

/** Air at the walker's position from the 1.2 m CFD slice (nearest sample). */
export function airAt(facility: Facility, results: FacilityResults | null, x: number, y: number): LocalAir | null {
  if (!results) return null;
  const here = roomAt(facility, x, y)?.id;
  let best: FacilityResults['vectors'][number] | null = null;
  let bestDist = Infinity;
  for (const v of results.vectors) {
    const d = Math.hypot(v.p[0] - x, v.p[1] - y);
    if (d >= bestDist || d > 0.8) continue;
    // Never read air through a wall from the room next door.
    if (roomAt(facility, v.p[0], v.p[1])?.id !== here) continue;
    if (d < bestDist) {
      bestDist = d;
      best = v;
    }
  }
  if (!best || bestDist > 0.8) return null;
  return { speed: best.m, dir: best.d, distance: bestDist };
}
