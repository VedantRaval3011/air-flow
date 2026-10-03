/**
 * Geometry derived from a Facility: wall segments (from the room footprints),
 * placed air terminals (from the RDS counts), and the colour schemes used by
 * the drawings. Shared by the 3D view and the solver so both see the same
 * building.
 */

import {
  Facility,
  FacilityDoor,
  FacilityRoom,
  PlacedTerminal,
  PlanRect,
  TerminalCode,
  TerminalMoves,
  TerminalSpec,
} from './types';

export const CFM_TO_M3S = 0.00047194745;
export const CFM_TO_M3H = CFM_TO_M3S * 3600;

export const WALL_THICKNESS = 0.1;

/**
 * Terminal catalogue. Rated flows are the RDS header values; face sizes follow
 * the sheet where it gives them (375 / 300 square diffusers) and common HEPA
 * box and riser sizes otherwise.
 */
export const TERMINALS: Record<TerminalCode, TerminalSpec> = {
  H1: { code: 'H1', label: 'HEPA 1220×610', role: 'supply', mount: 'ceiling', ratedCfm: 1000, width: 1.22, depth: 0.61 },
  H2: { code: 'H2', label: 'HEPA 610×610', role: 'supply', mount: 'ceiling', ratedCfm: 560, width: 0.61, depth: 0.61 },
  H3: { code: 'H3', label: 'HEPA 457×457', role: 'supply', mount: 'ceiling', ratedCfm: 250, width: 0.457, depth: 0.457 },
  SD1: { code: 'SD1', label: 'Supply diffuser 450', role: 'supply', mount: 'ceiling', ratedCfm: 1150, width: 0.45, depth: 0.45 },
  SD2: { code: 'SD2', label: 'Supply diffuser 375', role: 'supply', mount: 'ceiling', ratedCfm: 650, width: 0.375, depth: 0.375 },
  SD4: { code: 'SD4', label: 'Supply diffuser 300', role: 'supply', mount: 'ceiling', ratedCfm: 300, width: 0.3, depth: 0.3 },
  RD1: { code: 'RD1', label: 'Return diffuser 450', role: 'return', mount: 'ceiling', ratedCfm: 1150, width: 0.45, depth: 0.45 },
  RD2: { code: 'RD2', label: 'Return diffuser 375', role: 'return', mount: 'ceiling', ratedCfm: 650, width: 0.375, depth: 0.375 },
  RD4: { code: 'RD4', label: 'Return diffuser 300', role: 'return', mount: 'ceiling', ratedCfm: 300, width: 0.3, depth: 0.3 },
  R1: { code: 'R1', label: 'Return riser 900', role: 'return', mount: 'wall-low', ratedCfm: 600, width: 0.9, depth: 0.3 },
  R3: { code: 'R3', label: 'Return riser 750', role: 'return', mount: 'wall-low', ratedCfm: 490, width: 0.75, depth: 0.3 },
  R2: { code: 'R2', label: 'Return riser 600', role: 'return', mount: 'wall-low', ratedCfm: 380, width: 0.6, depth: 0.3 },
  SG1: { code: 'SG1', label: 'Supply grille 600', role: 'supply', mount: 'wall-high', ratedCfm: 1700, width: 0.6, depth: 0.3 },
  SG2: { code: 'SG2', label: 'Supply grille 450', role: 'supply', mount: 'wall-high', ratedCfm: 1000, width: 0.45, depth: 0.3 },
  SG3: { code: 'SG3', label: 'Supply grille 300', role: 'supply', mount: 'wall-high', ratedCfm: 500, width: 0.3, depth: 0.3 },
  RG1: { code: 'RG1', label: 'Exhaust grille 600', role: 'exhaust', mount: 'ceiling', ratedCfm: 1700, width: 0.6, depth: 0.6 },
  RG2: { code: 'RG2', label: 'Exhaust grille 450', role: 'exhaust', mount: 'ceiling', ratedCfm: 1000, width: 0.45, depth: 0.45 },
  RG3: { code: 'RG3', label: 'Exhaust grille 300', role: 'exhaust', mount: 'ceiling', ratedCfm: 500, width: 0.3, depth: 0.3 },
};

// ============= Colour schemes (match the SMB zoning / classification drawings) =============

export const AHU_COLORS: Record<string, string> = {
  'AHU-01': '#4338ca',
  'AHU-02': '#ea7a2f',
  'AHU-03': '#64748b',
  'AHU-04': '#16a34a',
  'AHU-05': '#dc2626',
  'AHU-5A': '#2563eb',
  'AHU-5B': '#84cc16',
  'AHU-5C': '#d946ef',
};
export const EXHAUST_COLOR = '#94a3b8';

export const CLASS_COLORS: Record<string, string> = {
  A: '#7c3aed',
  B: '#9333ea',
  C: '#0ea5e9',
  D: '#4f46e5',
  CNC: '#22c55e',
  NC: '#64748b',
};

export function ahuColor(ahu: string): string {
  return AHU_COLORS[ahu] ?? EXHAUST_COLOR;
}

/** Blue (0 Pa) → amber → red (≥ 40 Pa). */
export function pressureColor(pa: number): string {
  const t = Math.max(0, Math.min(1, pa / 40));
  const stops = [
    [0.58, 0.64, 0.72],
    [0.23, 0.51, 0.96],
    [0.96, 0.62, 0.04],
    [0.86, 0.15, 0.15],
  ];
  const s = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(s));
  const f = s - i;
  const c = stops[i].map((v, k) => v + (stops[i + 1][k] - v) * f);
  return `rgb(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)})`;
}

// ============= Room helpers =============

export function roomArea(room: FacilityRoom): number {
  return room.rects.reduce((sum, r) => sum + (r.x1 - r.x0) * (r.y1 - r.y0), 0);
}

export function roomVolume(room: FacilityRoom): number {
  return roomArea(room) * room.height;
}

export function roomCentroid(room: FacilityRoom): { x: number; y: number } {
  // Label at the centre of the largest rect, so L-shaped rooms stay readable.
  const r = largestRect(room);
  return { x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2 };
}

function largestRect(room: FacilityRoom): PlanRect {
  return room.rects.reduce((best, r) =>
    (r.x1 - r.x0) * (r.y1 - r.y0) > (best.x1 - best.x0) * (best.y1 - best.y0) ? r : best
  );
}

export function roomAt(facility: Facility, x: number, y: number): FacilityRoom | null {
  for (const room of facility.rooms) {
    for (const r of room.rects) {
      if (x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1) return room;
    }
  }
  return null;
}

// ============= Walls =============

export interface WallSegment {
  /** Fixed coordinate of the centreline, and the span along the wall */
  axis: 'x' | 'y';
  at: number;
  from: number;
  to: number;
  /** Rooms on the low side (smaller y / x) and high side; null = outside */
  lowRoom: string | null;
  highRoom: string | null;
  height: number;
}

const RASTER = 0.05;

/** Anything with a footprint that walls are drawn around. */
interface WallArea {
  id: string;
  rects: PlanRect[];
  height: number;
  openTo?: string[];
}

/** Walls of the ventilated rooms (the CFD / pressure-network domain). */
export function computeWalls(facility: Facility): WallSegment[] {
  return wallsFor(facility.rooms);
}

/**
 * Walls of the context areas: everything drawn on the zoning layout that is
 * not in the RDS. Walls the process rooms already have are left out.
 */
export function computeContextWalls(facility: Facility): WallSegment[] {
  const context = facility.contextRooms ?? [];
  if (context.length === 0) return [];
  const contextIds = new Set(context.map((c) => c.id));
  const isContextOrOutside = (id: string | null) => id === null || contextIds.has(id);
  return wallsFor([...facility.rooms, ...context]).filter(
    (w) => isContextOrOutside(w.lowRoom) && isContextOrOutside(w.highRoom)
  );
}

/**
 * Walls fall wherever the area label changes. The plan is rasterised at 5 cm,
 * boundaries are collected per row/column and merged into straight runs, so
 * L-shaped rooms and T-junctions come out right without any polygon clipping.
 */
function wallsFor(areas: WallArea[]): WallSegment[] {
  const all = areas.flatMap((a) => a.rects);
  if (all.length === 0) return [];
  const minX = Math.min(...all.map((r) => r.x0));
  const minY = Math.min(...all.map((r) => r.y0));
  const maxX = Math.max(...all.map((r) => r.x1));
  const maxY = Math.max(...all.map((r) => r.y1));
  const nx = Math.ceil((maxX - minX) / RASTER) + 2;
  const ny = Math.ceil((maxY - minY) / RASTER) + 2;
  const ids = areas.map((a) => a.id);
  const heights = new Map(areas.map((a) => [a.id, a.height]));
  const open = new Set<string>();
  for (const a of areas) for (const o of a.openTo ?? []) open.add(`${a.id}|${o}`).add(`${o}|${a.id}`);
  const label = new Int16Array(nx * ny).fill(-1);

  // One cell of padding all round so the exterior walls are found too.
  for (let j = 1; j < ny - 1; j++) {
    for (let i = 1; i < nx - 1; i++) {
      const x = minX + (i - 1 + 0.5) * RASTER;
      const y = minY + (j - 1 + 0.5) * RASTER;
      const k = areas.findIndex((a) => a.rects.some((r) => x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1));
      label[i + nx * j] = k;
    }
  }

  const segments: WallSegment[] = [];
  const snap = (v: number) => Math.round(v * 100) / 100;
  const nameOf = (l: number) => (l < 0 ? null : ids[l]);
  const heightOf = (a: number, b: number) =>
    Math.max(a >= 0 ? heights.get(ids[a]) ?? 0 : 0, b >= 0 ? heights.get(ids[b]) ?? 0 : 0);
  const separates = (a: number, b: number) => a !== b && !(a >= 0 && b >= 0 && open.has(`${ids[a]}|${ids[b]}`));

  // Vertical walls: between column i and i+1, running along y.
  for (let i = 0; i < nx - 1; i++) {
    let run: { a: number; b: number; start: number } | null = null;
    for (let j = 0; j <= ny; j++) {
      const a = j < ny ? label[i + nx * j] : -2;
      const b = j < ny ? label[i + 1 + nx * j] : -2;
      const wall = j < ny && separates(a, b);
      if (run && (!wall || a !== run.a || b !== run.b)) {
        segments.push({
          axis: 'y',
          at: snap(minX + i * RASTER),
          from: snap(minY + (run.start - 1) * RASTER),
          to: snap(minY + (j - 1) * RASTER),
          lowRoom: nameOf(run.a),
          highRoom: nameOf(run.b),
          height: heightOf(run.a, run.b),
        });
        run = null;
      }
      if (wall && !run) run = { a, b, start: j };
    }
  }

  // Horizontal walls: between row j and j+1, running along x.
  for (let j = 0; j < ny - 1; j++) {
    let run: { a: number; b: number; start: number } | null = null;
    for (let i = 0; i <= nx; i++) {
      const a = i < nx ? label[i + nx * j] : -2;
      const b = i < nx ? label[i + nx * (j + 1)] : -2;
      const wall = i < nx && separates(a, b);
      if (run && (!wall || a !== run.a || b !== run.b)) {
        segments.push({
          axis: 'x',
          at: snap(minY + j * RASTER),
          from: snap(minX + (run.start - 1) * RASTER),
          to: snap(minX + (i - 1) * RASTER),
          lowRoom: nameOf(run.a),
          highRoom: nameOf(run.b),
          height: heightOf(run.a, run.b),
        });
        run = null;
      }
      if (wall && !run) run = { a, b, start: i };
    }
  }

  return segments.filter((s) => s.to - s.from > 1e-6);
}

/** Doors lying on a wall segment (same orientation, on the centreline, overlapping its span). */
export function doorsOnWall(wall: WallSegment, doors: FacilityDoor[]): FacilityDoor[] {
  return doors.filter((d) => {
    const at = wall.axis === 'x' ? d.y : d.x;
    const along = wall.axis === 'x' ? d.x : d.y;
    return (
      d.axis === wall.axis &&
      Math.abs(at - wall.at) < 0.08 &&
      along + d.width / 2 > wall.from &&
      along - d.width / 2 < wall.to
    );
  });
}

// ============= Terminal placement =============

/** Split `total` into integer parts proportional to `weights` (largest remainder). */
function apportion(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const exact = weights.map((w) => (total * w) / sum);
  const out = exact.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = exact.map((e, i) => ({ i, r: e - Math.floor(e) })).sort((a, b) => b.r - a.r);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) out[order[k].i]++;
  return out;
}

/** Evenly spaced grid positions for n items in a rect, snaking row by row. */
function gridPositions(r: PlanRect, n: number): { x: number; y: number }[] {
  if (n <= 0) return [];
  const w = r.x1 - r.x0;
  const d = r.y1 - r.y0;
  const cols = Math.max(1, Math.min(n, Math.round(Math.sqrt((n * w) / d))));
  const rows = Math.ceil(n / cols);
  const out: { x: number; y: number }[] = [];
  for (let row = 0; row < rows; row++) {
    const inRow = Math.min(cols, n - row * cols);
    for (let c = 0; c < inRow; c++) {
      const col = row % 2 === 0 ? c : inRow - 1 - c;
      out.push({ x: r.x0 + ((col + 0.5) * w) / inRow, y: r.y0 + ((row + 0.5) * d) / rows });
    }
  }
  return out;
}

interface WallRun {
  axis: 'x' | 'y';
  at: number;
  from: number;
  to: number;
  /** Unit normal pointing into the room */
  normal: { x: number; y: number };
  exterior: boolean;
}

/** Stretches of a room's own walls that are free of doors, with corner margins. */
function wallRuns(room: FacilityRoom, walls: WallSegment[], doors: FacilityDoor[], margin: number): WallRun[] {
  const runs: WallRun[] = [];
  for (const wall of walls) {
    const low = wall.lowRoom === room.id;
    const high = wall.highRoom === room.id;
    if (!low && !high) continue;
    const other = low ? wall.highRoom : wall.lowRoom;
    // Room is on the low side → the room interior is towards -axis.
    const sign = low ? -1 : 1;
    const normal = wall.axis === 'x' ? { x: 0, y: sign } : { x: sign, y: 0 };

    // Cut the doors out of the wall.
    let pieces = [{ from: wall.from + margin, to: wall.to - margin }];
    for (const door of doorsOnWall(wall, doors)) {
      const c = wall.axis === 'x' ? door.x : door.y;
      const d0 = c - door.width / 2 - margin;
      const d1 = c + door.width / 2 + margin;
      pieces = pieces.flatMap((p) =>
        d1 <= p.from || d0 >= p.to
          ? [p]
          : [
              { from: p.from, to: Math.max(p.from, d0) },
              { from: Math.min(p.to, d1), to: p.to },
            ]
      );
    }
    for (const p of pieces) {
      if (p.to - p.from > 0.2) {
        runs.push({ axis: wall.axis, at: wall.at, from: p.from, to: p.to, normal, exterior: other === null });
      }
    }
  }
  // Longest walls first: risers are normally spread along the long walls.
  return runs.sort((a, b) => b.to - b.from - (a.to - a.from));
}

/** Spread n wall terminals of the given width along the runs. */
function placeAlongWalls(runs: WallRun[], n: number, width: number) {
  const usable = runs.filter((r) => r.to - r.from >= width + 0.1);
  if (usable.length === 0 || n <= 0) return [];
  const lengths = usable.map((r) => r.to - r.from);
  // Each run can physically hold only so many grilles side by side.
  const counts = apportion(n, lengths);
  const out: { run: WallRun; along: number }[] = [];
  counts.forEach((k, idx) => {
    const run = usable[idx];
    const cap = Math.max(1, Math.floor((run.to - run.from) / (width + 0.15)));
    const m = Math.min(k, cap);
    for (let q = 0; q < m; q++) out.push({ run, along: run.from + ((q + 0.5) * (run.to - run.from)) / m });
  });
  // Anything that did not fit goes on the longest run, doubled up.
  for (let q = out.length; q < n; q++) {
    const run = usable[0];
    out.push({ run, along: run.from + ((q + 0.25) % 1) * (run.to - run.from) });
  }
  return out;
}

/**
 * Place every terminal listed in the RDS for each room. Ceiling terminals sit
 * on a regular grid (supplies and ceiling returns interleaved), risers are
 * spread along the room's walls clear of doors. The RDS flow for the room is
 * shared between its terminals in proportion to their rated flow.
 */
export function placeTerminals(
  facility: Facility,
  walls = computeWalls(facility),
  moves: TerminalMoves = {}
): PlacedTerminal[] {
  const placed: PlacedTerminal[] = [];

  for (const room of facility.rooms) {
    const hv = room.hvac;
    const entries = Object.entries(hv.terminals) as [TerminalCode, number][];
    const specs = entries.flatMap(([code, count]) => Array.from({ length: count }, () => TERMINALS[code]));
    if (specs.length === 0) continue;

    const ceilingSupply = specs.filter((s) => s.mount === 'ceiling' && s.role === 'supply');
    const ceilingExtract = specs.filter((s) => s.mount === 'ceiling' && s.role !== 'supply');
    const wallLow = specs.filter((s) => s.mount === 'wall-low');
    const wallHigh = specs.filter((s) => s.mount === 'wall-high');

    // Flow shares.
    const supplyTerms = specs.filter((s) => s.role === 'supply');
    const returnTerms = specs.filter((s) => s.role === 'return');
    const exhaustTerms = specs.filter((s) => s.role === 'exhaust');
    // Exhaust-only rooms (toilets) list make-up supply grilles but no supply
    // flow: they pass the exhausted air.
    const supplyTotal = hv.supplyCfm > 0 ? hv.supplyCfm : hv.exhaustCfm;
    const share = (spec: TerminalSpec) => {
      const pool = spec.role === 'supply' ? supplyTerms : spec.role === 'return' ? returnTerms : exhaustTerms;
      const total = spec.role === 'supply' ? supplyTotal : spec.role === 'return' ? hv.returnCfm : hv.exhaustCfm;
      const rated = pool.reduce((a, s) => a + s.ratedCfm, 0) || 1;
      return (total * spec.ratedCfm) / rated;
    };

    let seq = 0;
    const nextId = (code: string) => `${room.id}-${code}-${++seq}`;

    // --- Ceiling: interleave supplies and extracts on one grid -------------
    const ceiling: TerminalSpec[] = [];
    const sup = [...ceilingSupply];
    const ext = [...ceilingExtract];
    while (sup.length || ext.length) {
      if (sup.length) ceiling.push(sup.shift() as TerminalSpec);
      if (ext.length) ceiling.push(ext.shift() as TerminalSpec);
    }
    const rects = room.rects;
    const perRect = apportion(
      ceiling.length,
      rects.map((r) => (r.x1 - r.x0) * (r.y1 - r.y0))
    );
    let cursor = 0;
    rects.forEach((r, ri) => {
      // Keep terminals off the walls by the larger half-size plus a margin.
      const inset = 0.45;
      const inner: PlanRect = {
        x0: r.x0 + Math.min(inset, (r.x1 - r.x0) / 3),
        y0: r.y0 + Math.min(inset, (r.y1 - r.y0) / 3),
        x1: r.x1 - Math.min(inset, (r.x1 - r.x0) / 3),
        y1: r.y1 - Math.min(inset, (r.y1 - r.y0) / 3),
      };
      for (const pos of gridPositions(inner, perRect[ri])) {
        const spec = ceiling[cursor++];
        // Long HEPA boxes run along the longer side of the room.
        const alongX = r.x1 - r.x0 >= r.y1 - r.y0;
        placed.push({
          id: nextId(spec.code),
          roomId: room.id,
          code: spec.code,
          role: spec.role,
          mount: 'ceiling',
          x: pos.x,
          y: pos.y,
          z: room.height,
          width: alongX ? spec.width : spec.depth,
          depth: alongX ? spec.depth : spec.width,
          cfm: share(spec),
        });
      }
    });

    // --- Walls -------------------------------------------------------------
    const runs = wallRuns(room, walls, facility.doors, 0.25);
    const addWall = (list: TerminalSpec[], zFor: (s: TerminalSpec) => number, prefer?: (r: WallRun) => boolean) => {
      if (list.length === 0) return;
      const ordered = prefer ? [...runs.filter(prefer), ...runs.filter((r) => !prefer(r))] : runs;
      const spots = placeAlongWalls(ordered, list.length, Math.max(...list.map((s) => s.width)));
      spots.forEach(({ run, along }, k) => {
        const spec = list[k];
        const offset = WALL_THICKNESS / 2;
        const x = run.axis === 'y' ? run.at + run.normal.x * offset : along;
        const y = run.axis === 'x' ? run.at + run.normal.y * offset : along;
        placed.push({
          id: nextId(spec.code),
          roomId: room.id,
          code: spec.code,
          role: spec.role,
          mount: spec.mount,
          x,
          y,
          z: zFor(spec),
          width: spec.width,
          depth: spec.depth,
          normal: run.normal,
          cfm: share(spec),
        });
      });
    };
    // Risers: bottom of the grille 150 mm above the floor.
    addWall(wallLow, (s) => 0.15 + s.depth / 2, (r) => !r.exterior);
    // High-level make-up grilles go on the outside wall where there is one.
    addWall(wallHigh, (s) => room.height - 0.25 - s.depth / 2, (r) => r.exterior);

    // Exhaust with nothing to replace it (the electrical room) draws make-up
    // air through its exterior door; model that as a door louvre.
    const hasSupply = specs.some((s) => s.role === 'supply');
    if (!hasSupply && hv.exhaustCfm > 0) {
      const door = facility.doors.find((d) => d.rooms[0] === room.id && d.rooms[1] === null);
      if (door) {
        const inward = inwardNormalAtDoor(room, door);
        placed.push({
          id: nextId('LOUVRE'),
          roomId: room.id,
          code: 'SG2',
          role: 'supply',
          mount: 'wall-low',
          x: door.x + inward.x * (WALL_THICKNESS / 2),
          y: door.y + inward.y * (WALL_THICKNESS / 2),
          // Sized for ~1 m/s face velocity, the usual door-louvre limit.
          z: 0.45,
          width: door.width - 0.2,
          depth: 0.6,
          normal: inward,
          cfm: hv.exhaustCfm,
          auto: true,
        });
      }
    }
  }

  return placed.map((t) => (moves[t.id] ? moveTerminal(facility, walls, t, moves[t.id]) : t));
}

/**
 * Put a terminal where the user dropped it, keeping it physically sensible:
 * ceiling terminals stay inside their room, wall terminals (risers, grilles)
 * slide onto the nearest stretch of their own room's wall.
 */
export function moveTerminal(
  facility: Facility,
  walls: WallSegment[],
  t: PlacedTerminal,
  target: { x: number; y: number }
): PlacedTerminal {
  const room = facility.rooms.find((r) => r.id === t.roomId);
  if (!room) return t;

  if (t.mount === 'ceiling') {
    let best = { x: t.x, y: t.y, d: Infinity };
    for (const r of room.rects) {
      const hx = Math.min(t.width / 2, (r.x1 - r.x0) / 2);
      const hy = Math.min(t.depth / 2, (r.y1 - r.y0) / 2);
      const x = Math.min(r.x1 - hx, Math.max(r.x0 + hx, target.x));
      const y = Math.min(r.y1 - hy, Math.max(r.y0 + hy, target.y));
      const d = Math.hypot(x - target.x, y - target.y);
      if (d < best.d) best = { x, y, d };
    }
    return { ...t, x: best.x, y: best.y };
  }

  let best: { x: number; y: number; normal: { x: number; y: number }; d: number } | null = null;
  for (const w of walls) {
    const low = w.lowRoom === room.id;
    if (!low && w.highRoom !== room.id) continue;
    const half = t.width / 2;
    if (w.to - w.from < t.width) continue;
    const alongTarget = w.axis === 'x' ? target.x : target.y;
    const along = Math.min(w.to - half, Math.max(w.from + half, alongTarget));
    const sign = low ? -1 : 1;
    const normal = w.axis === 'x' ? { x: 0, y: sign } : { x: sign, y: 0 };
    const x = w.axis === 'x' ? along : w.at + normal.x * (WALL_THICKNESS / 2);
    const y = w.axis === 'x' ? w.at + normal.y * (WALL_THICKNESS / 2) : along;
    const d = Math.hypot(x - target.x, y - target.y);
    if (!best || d < best.d) best = { x, y, normal, d };
  }
  return best ? { ...t, x: best.x, y: best.y, normal: best.normal } : t;
}

function inwardNormalAtDoor(room: FacilityRoom, door: FacilityDoor): { x: number; y: number } {
  const probe = 0.2;
  const inside = (x: number, y: number) => room.rects.some((r) => x > r.x0 && x < r.x1 && y > r.y0 && y < r.y1);
  if (door.axis === 'x') return inside(door.x, door.y + probe) ? { x: 0, y: 1 } : { x: 0, y: -1 };
  return inside(door.x + probe, door.y) ? { x: 1, y: 0 } : { x: -1, y: 0 };
}

/** Designed direction of leakage through a door, from the RDS room pressures. */
export function cascadeDirection(facility: Facility, door: FacilityDoor): 'forward' | 'reverse' | 'none' {
  const [a, b] = door.rooms;
  if (!b) return 'none';
  const pa = facility.rooms.find((r) => r.id === a)?.hvac.pressurePa ?? 0;
  const pb = facility.rooms.find((r) => r.id === b)?.hvac.pressurePa ?? 0;
  if (Math.abs(pa - pb) < 1) return 'none';
  return pa > pb ? 'forward' : 'reverse';
}
