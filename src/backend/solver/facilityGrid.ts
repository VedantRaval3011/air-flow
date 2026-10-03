/**
 * Builds a solver grid for a whole floor (see lib/facility).
 *
 * The floor's bounding box is split into cells; each cell takes the room its
 * centre falls in. Cells above a room's ceiling, outside every room, or on a
 * boundary between two rooms (a one-cell partition) are solid. Doors reopen
 * the partition: fully up to the door head when doors are open, or just the
 * bottom cell layer when they are closed. That bottom layer stands in for the
 * door undercut and leakage path, which carries the pressure-cascade flow
 * between rooms.
 *
 * Terminals become fixed-velocity patches carrying their RDS flow. Supplies
 * are imposed exactly. Extracts in each connected region are scaled together
 * so they remove exactly what is supplied there. This stands in for the
 * exfiltration to outside that the RDS allows for but the model has no path
 * for.
 */

import { Facility, FacilityDoor, FacilitySimulationOptions, PlacedTerminal } from '@/lib/facility/types';
import { CFM_TO_M3S, computeWalls, placeTerminals } from '@/lib/facility/geometry';
import { FLUID, Grid, INLET, OUTLET, SOLID, VentPatch } from './grid';

export interface FacilityGrid {
  grid: Grid;
  /** Room index (into facility.rooms) of every cell, -1 for solid */
  cellRoom: Int16Array;
  /** Partition cells reopened for each door, with the flux axis */
  doorCells: Map<string, { cells: number[]; axis: 'x' | 'y'; lowRoom: string | null }>;
  terminals: PlacedTerminal[];
  /** Terminal id → room id for each patch */
  patchRoom: Map<string, string>;
  /** Design extract (m³/s) before balancing, and the scale applied to it */
  extractDesign: number;
  extractScale: number;
  warnings: string[];
}

/**
 * A door on the edge of a room study: the rooms beyond it are not solved, so
 * the air crossing it is imposed (from the pressure network).
 */
export interface BoundaryDoor {
  door: FacilityDoor;
  /** The solved room this door belongs to */
  inside: string;
  /** Flow into `inside` through the door (m³/s); negative = leaving */
  flowIn: number;
  open: boolean;
}

export type FacilityGridOptions = FacilitySimulationOptions & {
  boundaryDoors?: BoundaryDoor[];
  /**
   * Terminals already placed (room studies pass the whole floor's placement,
   * so a room sees exactly the terminals shown and moved in the viewer).
   */
  terminals?: PlacedTerminal[];
};

export function buildFacilityGrid(input: Facility, options: FacilityGridOptions): FacilityGrid {
  const warnings: string[] = [];
  const facility = withRoomFlows(input, options.roomFlows);
  const isOpen = (id: string) => options.doorsOpen?.[id] ?? options.doorMode === 'open';
  const h = options.cellSize ?? 0.25;
  const width = facility.extent.width;
  const depth = facility.extent.depth;
  const maxHeight = Math.max(...facility.rooms.map((r) => r.height));

  const nx = Math.max(4, Math.round(width / h));
  const ny = Math.max(4, Math.round(depth / h));
  const nz = Math.max(4, Math.round(maxHeight / h));
  const hx = width / nx;
  const hy = depth / ny;
  const hz = maxHeight / nz;
  const n = nx * ny * nz;
  const plane = nx * ny;

  const rooms = facility.rooms;
  const roomIndex = new Map(rooms.map((r, i) => [r.id, i]));
  const openPairs = new Set<string>();
  for (const r of rooms) for (const o of r.openTo ?? []) {
    openPairs.add(`${r.id}|${o}`);
    openPairs.add(`${o}|${r.id}`);
  }

  // --- Plan raster ------------------------------------------------------------
  const label2d = new Int16Array(plane).fill(-1);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = (i + 0.5) * hx;
      const y = (j + 0.5) * hy;
      for (let r = 0; r < rooms.length; r++) {
        if (rooms[r].rects.some((q) => x >= q.x0 && x < q.x1 && y >= q.y0 && y < q.y1)) {
          label2d[i + nx * j] = r;
          break;
        }
      }
    }
  }

  const separated = (a: number, b: number) =>
    a >= 0 && b >= 0 && a !== b && !openPairs.has(`${rooms[a].id}|${rooms[b].id}`);

  // Partition cells: a cell whose +x or +y neighbour is another room. Every
  // face between two rooms then has a solid cell on exactly one side.
  const wall2d = new Uint8Array(plane);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const c = i + nx * j;
      const a = label2d[c];
      if (a < 0) continue;
      if ((i + 1 < nx && separated(a, label2d[c + 1])) || (j + 1 < ny && separated(a, label2d[c + nx]))) {
        wall2d[c] = 1;
      }
    }
  }

  // Door openings through the partitions: open height per plan cell.
  const openHeight2d = new Float32Array(plane);
  const doorPlanCells = new Map<string, { cells2d: number[]; axis: 'x' | 'y'; lowRoom: string | null }>();
  for (const door of facility.doors) {
    if (!door.rooms[1]) continue; // exterior doors stay shut
    const heightA = rooms[roomIndex.get(door.rooms[0]) ?? 0]?.height ?? 0;
    const heightB = rooms[roomIndex.get(door.rooms[1]) ?? 0]?.height ?? 0;
    const head = Math.min(door.height, heightA, heightB);
    const open = isOpen(door.id) ? head : hz;
    const cells2d: number[] = [];
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = i + nx * j;
        if (!wall2d[c]) continue;
        const x = (i + 0.5) * hx;
        const y = (j + 0.5) * hy;
        const across = door.axis === 'x' ? Math.abs(y - door.y) : Math.abs(x - door.x);
        const along = door.axis === 'x' ? Math.abs(x - door.x) : Math.abs(y - door.y);
        const reach = door.axis === 'x' ? hy : hx;
        if (across <= reach && along <= door.width / 2) {
          cells2d.push(c);
          openHeight2d[c] = Math.max(openHeight2d[c], open);
        }
      }
    }
    if (cells2d.length === 0) {
      warnings.push(`Door ${door.id} is narrower than one cell at ${h} m and was left closed.`);
    }
    doorPlanCells.set(door.id, { cells2d, axis: door.axis, lowRoom: lowSideRoom(facility, door) });
  }

  // --- 3D classification ------------------------------------------------------
  const type = new Uint8Array(n);
  const cellRoom = new Int16Array(n).fill(-1);
  for (let k = 0; k < nz; k++) {
    const z = (k + 0.5) * hz;
    for (let c2 = 0; c2 < plane; c2++) {
      const c = c2 + plane * k;
      const r = label2d[c2];
      if (r < 0 || z > rooms[r].height) {
        type[c] = SOLID;
        continue;
      }
      if (wall2d[c2] && !(z < openHeight2d[c2])) {
        type[c] = SOLID;
        continue;
      }
      cellRoom[c] = r;
    }
  }

  // --- Equipment, benches and people ---------------------------------------
  for (const o of options.objects ?? facility.objects ?? []) {
    if (!roomIndex.has(o.roomId)) continue;
    const i0 = Math.max(0, Math.floor((o.x - o.width / 2) / hx + 0.5));
    const i1 = Math.min(nx - 1, Math.ceil((o.x + o.width / 2) / hx - 0.5) - 1);
    const j0 = Math.max(0, Math.floor((o.y - o.depth / 2) / hy + 0.5));
    const j1 = Math.min(ny - 1, Math.ceil((o.y + o.depth / 2) / hy - 0.5) - 1);
    // Anything thinner than a cell still blocks the cell it stands in.
    const is = i1 >= i0 ? [i0, i1] : [Math.min(nx - 1, Math.max(0, Math.floor(o.x / hx))), Math.min(nx - 1, Math.max(0, Math.floor(o.x / hx)))];
    const js = j1 >= j0 ? [j0, j1] : [Math.min(ny - 1, Math.max(0, Math.floor(o.y / hy))), Math.min(ny - 1, Math.max(0, Math.floor(o.y / hy)))];
    const kTop = Math.min(nz, Math.max(1, Math.round(o.height / hz)));
    for (let k = 0; k < kTop; k++) {
      for (let j = js[0]; j <= js[1]; j++) {
        for (let i = is[0]; i <= is[1]; i++) {
          const c = i + nx * j + plane * k;
          type[c] = SOLID;
          cellRoom[c] = -1;
        }
      }
    }
  }

  const grid: Grid = {
    nx, ny, nz, n, hx, hy, hz,
    length: width,
    width: depth,
    height: maxHeight,
    type,
    ub: new Float32Array(n),
    vb: new Float32Array(n),
    wb: new Float32Array(n),
    patches: [],
    supplyFlow: 0,
  };

  // --- Terminals ------------------------------------------------------------
  const terminals = options.terminals ?? placeTerminals(facility, computeWalls(facility), options.terminalMoves);
  const patchRoom = new Map<string, string>();
  const nominal = new Map<string, number>(); // design flow per patch (m³/s)

  for (const t of terminals) {
    const r = roomIndex.get(t.roomId);
    if (r === undefined) continue;
    const cells = t.mount === 'ceiling' ? ceilingCells(grid, t, r, label2d, wall2d, rooms[r].height) : wallCells(grid, t, r, cellRoom);
    if (cells.length === 0) {
      warnings.push(`Terminal ${t.id} could not be mapped onto the grid.`);
      continue;
    }
    const inward =
      t.mount === 'ceiling'
        ? { x: 0, y: 0, z: -1 }
        : { x: t.normal?.x ?? 0, y: t.normal?.y ?? 0, z: 0 };
    const faceArea = t.mount === 'ceiling' ? hx * hy : (inward.x !== 0 ? hy : hx) * hz;
    const flow = t.cfm * CFM_TO_M3S;

    // A terminal cell claimed twice keeps its first owner.
    const own = cells.filter((c) => type[c] === FLUID);
    if (own.length === 0) continue;
    const kind = t.role === 'supply' ? 'inlet' : 'outlet';
    for (const c of own) type[c] = kind === 'inlet' ? INLET : OUTLET;

    const patch: VentPatch = { id: t.id, kind, inward, cells: own, area: own.length * faceArea, velocity: 0 };
    // Square ceiling diffusers throw air sideways along the ceiling (4-way),
    // unlike a HEPA terminal's straight downflow.
    if (kind === 'inlet' && t.mount === 'ceiling' && t.code.startsWith('SD')) {
      const radial = diffuserThrow(grid, own, t);
      patch.cellDirs = radial.dirs;
      patch.area = radial.effectiveArea;
    }
    if (kind === 'inlet') {
      patch.velocity = flow / patch.area;
      grid.supplyFlow += flow;
    }
    nominal.set(t.id, flow);
    patchRoom.set(t.id, t.roomId);
    grid.patches.push(patch);
  }

  // --- Doors on the edge of a room study ---------------------------------------
  for (const bd of options.boundaryDoors ?? []) {
    const r = roomIndex.get(bd.inside);
    if (r === undefined || Math.abs(bd.flowIn) < 1e-6) continue;
    const d = bd.door;
    const room = rooms[r];
    const probe = 0.2;
    const inside = (x: number, y: number) => room.rects.some((q) => x > q.x0 && x < q.x1 && y > q.y0 && y < q.y1);
    const inward =
      d.axis === 'x'
        ? { x: 0, y: inside(d.x, d.y + probe) ? 1 : -1, z: 0 }
        : { x: inside(d.x + probe, d.y) ? 1 : -1, y: 0, z: 0 };
    // Shut: the undercut / gap along the bottom. Open: the whole leaf.
    const layers = bd.open ? Math.max(1, Math.round(Math.min(d.height, room.height) / hz)) : 1;
    const cells: number[] = [];
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c2 = i + nx * j;
        if (label2d[c2] !== r || wall2d[c2]) continue;
        const x = (i + 0.5) * hx;
        const y = (j + 0.5) * hy;
        const across = d.axis === 'x' ? Math.abs(y - d.y) : Math.abs(x - d.x);
        const along = d.axis === 'x' ? Math.abs(x - d.x) : Math.abs(y - d.y);
        // The door sits on the wall centreline, half a wall outside a room study's air.
        if (across > (d.axis === 'x' ? hy : hx) + 0.06 || along > d.width / 2) continue;
        for (let k = 0; k < layers; k++) {
          const c = c2 + plane * k;
          if (type[c] === FLUID) cells.push(c);
        }
      }
    }
    if (cells.length === 0) {
      warnings.push(`Door ${d.id} could not be mapped onto the room-study grid.`);
      continue;
    }
    const faceArea = (d.axis === 'x' ? hx : hy) * hz;
    const kind = bd.flowIn > 0 ? 'inlet' : 'outlet';
    for (const c of cells) type[c] = kind === 'inlet' ? INLET : OUTLET;
    const id = `door:${d.id}`;
    const patch: VentPatch = { id, kind, inward, cells, area: cells.length * faceArea, velocity: 0 };
    if (kind === 'inlet') {
      patch.velocity = bd.flowIn / patch.area;
      grid.supplyFlow += bd.flowIn;
    }
    nominal.set(id, Math.abs(bd.flowIn));
    patchRoom.set(id, bd.inside);
    grid.patches.push(patch);
  }

  // --- Connected regions and mass balance --------------------------------------
  const { component, count } = labelComponents(grid);
  grid.component = component;
  grid.componentCount = count;

  const supplyIn = new Float64Array(count);
  const extractIn = new Float64Array(count);
  const regionOf = (p: VentPatch) => component[p.cells[0]];
  for (const p of grid.patches) {
    const region = regionOf(p);
    if (region < 0) continue;
    if (p.kind === 'inlet') supplyIn[region] += nominal.get(p.id) ?? 0;
    else extractIn[region] += nominal.get(p.id) ?? 0;
  }

  let extractDesign = 0;
  for (let r = 0; r < count; r++) extractDesign += extractIn[r];

  for (let r = 0; r < count; r++) {
    if (supplyIn[r] > 0 && extractIn[r] === 0) {
      warnings.push(`A closed-off region with ${(supplyIn[r] / CFM_TO_M3S).toFixed(0)} CFM of supply has no extract; mass cannot balance there.`);
    }
    if (supplyIn[r] === 0 && extractIn[r] > 0) {
      warnings.push(`A closed-off region with extract but no supply was left static.`);
    }
  }

  for (const p of grid.patches) {
    const region = regionOf(p);
    if (p.kind === 'outlet') {
      const scale = region >= 0 && extractIn[region] > 0 ? supplyIn[region] / extractIn[region] : 0;
      p.velocity = ((nominal.get(p.id) ?? 0) * scale) / p.area;
    }
    const sign = p.kind === 'inlet' ? 1 : -1;
    p.cells.forEach((c, n) => {
      const d = p.cellDirs ? [p.cellDirs[3 * n], p.cellDirs[3 * n + 1], p.cellDirs[3 * n + 2]] : [p.inward.x, p.inward.y, p.inward.z];
      grid.ub[c] = sign * d[0] * p.velocity;
      grid.vb[c] = sign * d[1] * p.velocity;
      grid.wb[c] = sign * d[2] * p.velocity;
    });
  }

  const doorCells = new Map<string, { cells: number[]; axis: 'x' | 'y'; lowRoom: string | null }>();
  for (const [id, d] of doorPlanCells) {
    const cells: number[] = [];
    for (const c2 of d.cells2d) {
      for (let k = 0; k < nz; k++) {
        const c = c2 + plane * k;
        if (type[c] !== SOLID) cells.push(c);
      }
    }
    doorCells.set(id, { cells, axis: d.axis, lowRoom: d.lowRoom });
  }

  return {
    grid,
    cellRoom,
    doorCells,
    terminals,
    patchRoom,
    extractDesign,
    extractScale: extractDesign > 0 ? grid.supplyFlow / extractDesign : 0,
    warnings,
  };
}

/** Replace the RDS design flows with delivered ones (e.g. from the pressure network). */
export function withRoomFlows(facility: Facility, flows: FacilitySimulationOptions['roomFlows']): Facility {
  if (!flows) return facility;
  return {
    ...facility,
    rooms: facility.rooms.map((room) => {
      const f = flows[room.id];
      if (!f) return room;
      return {
        ...room,
        hvac: { ...room.hvac, supplyCfm: Math.max(0, f.supplyCfm), returnCfm: Math.max(0, f.returnCfm), exhaustCfm: Math.max(0, f.exhaustCfm) },
      };
    }),
  };
}

/** Discharge angle of a ceiling diffuser below the horizontal. */
const DIFFUSER_THROW_ANGLE = (30 * Math.PI) / 180;

/**
 * Radial discharge for a ceiling diffuser: each cell blows away from the
 * diffuser centre, 30° below the ceiling. Returns the unit directions and the
 * effective open area (flux per unit speed through the patch's open faces),
 * so the imposed speed still delivers the terminal's volume flow.
 */
function diffuserThrow(g: Grid, cells: number[], t: PlacedTerminal): { dirs: number[]; effectiveArea: number } {
  const plane = g.nx * g.ny;
  const members = new Set(cells);
  const sinT = Math.sin(DIFFUSER_THROW_ANGLE);
  const cosT = Math.cos(DIFFUSER_THROW_ANGLE);
  const dirs: number[] = [];
  let area = 0;
  for (const c of cells) {
    const i = c % g.nx;
    const j = Math.floor(c / g.nx) % g.ny;
    const k = Math.floor(c / plane);
    let rx = (i + 0.5) * g.hx - t.x;
    let ry = (j + 0.5) * g.hy - t.y;
    const len = Math.hypot(rx, ry);
    // A diffuser smaller than a cell: blow evenly down and out.
    if (len < 1e-6) {
      dirs.push(0, 0, -1);
      area += g.hx * g.hy;
      continue;
    }
    rx /= len;
    ry /= len;
    dirs.push(rx * cosT, ry * cosT, -sinT);
    const open = (nb: number) => nb >= 0 && !members.has(nb) && g.type[nb] !== SOLID;
    if (k > 0 && open(c - plane)) area += sinT * g.hx * g.hy;
    if (rx > 0 && i < g.nx - 1 && open(c + 1)) area += rx * cosT * g.hy * g.hz;
    if (rx < 0 && i > 0 && open(c - 1)) area += -rx * cosT * g.hy * g.hz;
    if (ry > 0 && j < g.ny - 1 && open(c + g.nx)) area += ry * cosT * g.hx * g.hz;
    if (ry < 0 && j > 0 && open(c - g.nx)) area += -ry * cosT * g.hx * g.hz;
  }
  return { dirs, effectiveArea: Math.max(area, 1e-4) };
}

/** Room on the low-coordinate side of a door (smaller y for an x-wall). */
function lowSideRoom(facility: Facility, door: FacilityDoor): string | null {
  const probe = 0.3;
  const x = door.axis === 'y' ? door.x - probe : door.x;
  const y = door.axis === 'x' ? door.y - probe : door.y;
  for (const id of door.rooms) {
    if (!id) continue;
    const room = facility.rooms.find((r) => r.id === id);
    if (room?.rects.some((q) => x >= q.x0 && x < q.x1 && y >= q.y0 && y < q.y1)) return id;
  }
  return null;
}

/** Top fluid layer of the room under the terminal footprint. */
function ceilingCells(
  g: Grid,
  t: PlacedTerminal,
  room: number,
  label2d: Int16Array,
  wall2d: Uint8Array,
  roomHeight: number
): number[] {
  const k = Math.min(g.nz - 1, Math.max(0, Math.floor(roomHeight / g.hz + 1e-6) - 1));
  const cells: number[] = [];
  let best = -1;
  let bestCover = -1;
  const x0 = t.x - t.width / 2;
  const x1 = t.x + t.width / 2;
  const y0 = t.y - t.depth / 2;
  const y1 = t.y + t.depth / 2;
  const i0 = Math.max(0, Math.floor(x0 / g.hx) - 1);
  const i1 = Math.min(g.nx - 1, Math.floor(x1 / g.hx) + 1);
  const j0 = Math.max(0, Math.floor(y0 / g.hy) - 1);
  const j1 = Math.min(g.ny - 1, Math.floor(y1 / g.hy) + 1);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const c2 = i + g.nx * j;
      if (label2d[c2] !== room || wall2d[c2]) continue;
      const cover =
        Math.max(0, Math.min(x1, (i + 1) * g.hx) - Math.max(x0, i * g.hx)) *
        Math.max(0, Math.min(y1, (j + 1) * g.hy) - Math.max(y0, j * g.hy));
      const c = c2 + g.nx * g.ny * k;
      if (cover > bestCover) {
        bestCover = cover;
        best = c;
      }
      if (cover >= 0.5 * g.hx * g.hy) cells.push(c);
    }
  }
  if (cells.length === 0 && best >= 0) cells.push(best);
  return cells;
}

/** First fluid cells of the room in front of a wall terminal. */
function wallCells(g: Grid, t: PlacedTerminal, room: number, cellRoom: Int16Array): number[] {
  const nrm = t.normal ?? { x: 0, y: 0 };
  const alongX = nrm.x === 0; // wall runs along x
  const zLo = t.z - t.depth / 2;
  const zHi = t.z + t.depth / 2;
  const half = t.width / 2;
  const cells: number[] = [];

  const ks: number[] = [];
  for (let k = 0; k < g.nz; k++) {
    const zc = (k + 0.5) * g.hz;
    if (zc >= zLo && zc <= zHi) ks.push(k);
  }
  if (ks.length === 0) ks.push(Math.min(g.nz - 1, Math.max(0, Math.floor(t.z / g.hz))));

  const span: number[] = [];
  const h = alongX ? g.hx : g.hy;
  const centre = alongX ? t.x : t.y;
  const count = alongX ? g.nx : g.ny;
  for (let a = 0; a < count; a++) {
    const ac = (a + 0.5) * h;
    if (Math.abs(ac - centre) <= Math.max(half, h / 2)) span.push(a);
  }

  for (const a of span) {
    for (const k of ks) {
      // Walk from the wall face into the room until the first cell of this room.
      for (let step = 0; step < 4; step++) {
        // Half a cell in from the face, so a face on the domain edge still lands in the room.
        const px = alongX ? (a + 0.5) * g.hx : t.x + nrm.x * (step + 0.5) * g.hx;
        const py = alongX ? t.y + nrm.y * (step + 0.5) * g.hy : (a + 0.5) * g.hy;
        const i = Math.floor(px / g.hx);
        const j = Math.floor(py / g.hy);
        if (i < 0 || j < 0 || i >= g.nx || j >= g.ny) break;
        const c = i + g.nx * (j + g.ny * k);
        if (cellRoom[c] === room && g.type[c] !== SOLID) {
          cells.push(c);
          break;
        }
      }
    }
  }
  return cells;
}

/** Face-connected regions of non-solid cells. */
function labelComponents(g: Grid): { component: Int32Array; count: number } {
  const component = new Int32Array(g.n).fill(-1);
  const stack = new Int32Array(g.n);
  const plane = g.nx * g.ny;
  let count = 0;
  for (let start = 0; start < g.n; start++) {
    if (g.type[start] === SOLID || component[start] >= 0) continue;
    let top = 0;
    stack[top++] = start;
    component[start] = count;
    while (top > 0) {
      const c = stack[--top];
      const i = c % g.nx;
      const j = Math.floor(c / g.nx) % g.ny;
      const k = Math.floor(c / plane);
      const nbs = [
        i > 0 ? c - 1 : -1,
        i < g.nx - 1 ? c + 1 : -1,
        j > 0 ? c - g.nx : -1,
        j < g.ny - 1 ? c + g.nx : -1,
        k > 0 ? c - plane : -1,
        k < g.nz - 1 ? c + plane : -1,
      ];
      for (const nb of nbs) {
        if (nb < 0 || g.type[nb] === SOLID || component[nb] >= 0) continue;
        component[nb] = count;
        stack[top++] = nb;
      }
    }
    count++;
  }
  return { component, count };
}
