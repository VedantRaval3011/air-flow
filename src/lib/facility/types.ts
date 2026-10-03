/**
 * Multi-room facility layout: a whole floor of cleanrooms, corridors and
 * support rooms, with the HVAC data from the project's Room Data Sheet (RDS).
 *
 * Plan coordinates are metres. x runs left-to-right across the drawing and y
 * runs top-to-bottom down it; z is height above the finished floor. The solver
 * uses the same axes; the 3D view maps (x, y, z) to three.js (x, z, y).
 */

/** Axis-aligned footprint rectangle, [x0, y0] top-left to [x1, y1] bottom-right. */
export interface PlanRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** GMP area classification (EU grade at rest), or CNC / NC for non-classified. */
export type AreaClass = 'A' | 'B' | 'C' | 'D' | 'CNC' | 'NC';

/**
 * Terminal types, named after the RDS columns:
 *   H1/H2/H3   ceiling HEPA filters (supply)
 *   SD1/SD2/SD4 ceiling supply diffusers
 *   RD1/RD2/RD4 ceiling return diffusers
 *   R1/R2/R3   low-level return air risers on walls
 *   SG1/SG2/SG3 supply (make-up) grilles
 *   RG1/RG2/RG3 exhaust / return grilles
 */
export type TerminalCode =
  | 'H1' | 'H2' | 'H3'
  | 'SD1' | 'SD2' | 'SD4'
  | 'RD1' | 'RD2' | 'RD4'
  | 'R1' | 'R2' | 'R3'
  | 'SG1' | 'SG2' | 'SG3'
  | 'RG1' | 'RG2' | 'RG3';

export type TerminalRole = 'supply' | 'return' | 'exhaust';
export type TerminalMount = 'ceiling' | 'wall-low' | 'wall-high';

export interface TerminalSpec {
  code: TerminalCode;
  label: string;
  role: TerminalRole;
  mount: TerminalMount;
  /** Rated flow from the RDS header row (CFM) */
  ratedCfm: number;
  /** Face size in metres: width along the ceiling/wall, and depth (ceiling) or height (wall) */
  width: number;
  depth: number;
}

/** Room data taken from the RDS. Flows are CFM, pressures Pa, as in the sheet. */
export interface RoomHvac {
  ahu: string;
  areaClass: AreaClass;
  pressurePa: number;
  temperatureF: number;
  rhPercent: number;
  occupancy: number;
  equipmentKw: number;
  acph: number;
  supplyCfm: number;
  returnCfm: number;
  exhaustCfm: number;
  freshAirCfm: number;
  infiltrationCfm: number;
  exfiltrationCfm: number;
  terminalType: 'HEPA' | 'DIFFUSER' | 'NA';
  /** Terminal counts by RDS column */
  terminals: Partial<Record<TerminalCode, number>>;
}

export interface FacilityRoom {
  id: string;
  /** Name as written in the RDS */
  name: string;
  /** Short label for the 3D view */
  shortName: string;
  /** RDS serial number */
  rdsNo?: number;
  /** Nominal dimensions from the RDS (m) */
  nominal: { length: number; width: number; height: number };
  /** Footprint on the plan; several rects form an L- or T-shaped room */
  rects: PlanRect[];
  /** Clear height to the ceiling (m) */
  height: number;
  hvac: RoomHvac;
  /** Rooms this one opens into with no wall between (e.g. two corridor legs) */
  openTo?: string[];
}

export interface FacilityDoor {
  id: string;
  /** Centre of the door on the wall centreline */
  x: number;
  y: number;
  /** 'x' when the wall runs along x (door in a horizontal wall), 'y' otherwise */
  axis: 'x' | 'y';
  width: number;
  height: number;
  /** Rooms either side; `null` for an exterior door */
  rooms: [string, string | null];
}

/** A placed terminal, generated from the RDS counts (see geometry.ts). */
export interface PlacedTerminal {
  id: string;
  roomId: string;
  code: TerminalCode;
  role: TerminalRole;
  mount: TerminalMount;
  /** Centre of the face. Ceiling: z = room height. Wall: z = centre height. */
  x: number;
  y: number;
  z: number;
  width: number;
  depth: number;
  /** For wall terminals: unit normal pointing into the room */
  normal?: { x: number; y: number };
  /** Design flow through this terminal (CFM) */
  cfm: number;
  /** Added by the model rather than listed in the RDS (e.g. make-up air) */
  auto?: boolean;
}

/** Air handling unit or exhaust fan, from the AHU summary rows of the RDS. */
export interface AirHandler {
  id: string;
  kind: 'ahu' | 'exhaust';
  /** Rated (selected) unit capacity, CFM */
  ratedCfm: number;
  supplyCfm: number;
  returnCfm: number;
  freshAirCfm: number;
  bleedCfm: number;
  coolingTr?: number;
  heatingKw?: number;
  filtration?: string;
}

/**
 * Areas shown on the drawings that are not in the RDS (stores, lobby, stairs):
 * drawn for context, not ventilated in the model.
 */
export interface ContextRoom {
  id: string;
  name: string;
  rects: PlanRect[];
  height: number;
}

export type ObjectKind = 'equipment' | 'table' | 'person' | 'cabinet';

/** Something standing in a room that blocks the air: a machine, a bench, a person. */
export interface FacilityObject {
  id: string;
  roomId: string;
  kind: ObjectKind;
  name: string;
  /** Centre on the plan (m) */
  x: number;
  y: number;
  /** Footprint along x / y and height (m) */
  width: number;
  depth: number;
  height: number;
}

/** A terminal dragged away from its auto-placed position (plan centre, m). */
export type TerminalMoves = Record<string, { x: number; y: number }>;

export interface Facility {
  id: string;
  name: string;
  project: string;
  floor: string;
  /** Source documents, for the record */
  sources: string[];
  /** Overall extent of the modelled area (m) */
  extent: { width: number; depth: number };
  rooms: FacilityRoom[];
  doors: FacilityDoor[];
  airHandlers: AirHandler[];
  /** Equipment, benches and people, as first placed (users can move them) */
  objects: FacilityObject[];
  contextRooms?: ContextRoom[];
}

/** How doors are treated in the flow model. */
export type DoorMode = 'closed' | 'open';

/** Supply / extract actually delivered to a room, e.g. from the pressure network (CFM). */
export interface RoomFlowOverride {
  supplyCfm: number;
  returnCfm: number;
  exhaustCfm: number;
}

export interface FacilitySimulationOptions {
  /** Default door state; `doorsOpen` overrides it per door */
  doorMode: DoorMode;
  doorsOpen?: Record<string, boolean>;
  /** Room flows to impose instead of the RDS design values */
  roomFlows?: Record<string, RoomFlowOverride>;
  /** Objects in the rooms (replaces facility.objects when given) */
  objects?: FacilityObject[];
  terminalMoves?: TerminalMoves;
  /**
   * Solve only these rooms (a room study). Air crossing the doors on their
   * boundary is imposed from `doorFlowsCfm` (the pressure network).
   */
  roomIds?: string[];
  /** Flow through each door from rooms[0] to rooms[1] (CFM) */
  doorFlowsCfm?: Record<string, number>;
  /** Horizontal cell size (m) */
  cellSize?: number;
}

export interface FacilitySimulationRequest {
  facility: Facility;
  options: FacilitySimulationOptions;
}

// ============= Results =============

export interface RoomFlowResult {
  roomId: string;
  /** Supply imposed in the model (m³/h) */
  supplyM3h: number;
  /** Return + exhaust extracted in the model (m³/h) */
  extractM3h: number;
  /** Achieved air changes per hour from the modelled supply */
  achievedAcph: number;
  meanSpeed: number;
  /** Mean speed in the 0.5–1.8 m working zone */
  workingZoneSpeed: number;
  /** Fraction of the room volume moving slower than the dead-zone threshold */
  stagnantFraction: number;
  /** Net air leaving through doors (m³/h); positive = room pushes air out */
  netDoorOutflowM3h: number;
}

export interface DoorFlowResult {
  doorId: string;
  /** Net flow from rooms[0] to rooms[1] (m³/h); negative means the reverse */
  flowM3h: number;
  /** Direction the design pressure cascade expects, from the RDS pressures */
  expected: 'forward' | 'reverse' | 'none';
  /** Whether the modelled flow agrees with the cascade */
  agrees: boolean | null;
}

/** Horizontal cut through the flow at working height, one value per cell. */
export interface SpeedSlice {
  z: number;
  /** Plan position of the first cell's corner and the cell size (m) */
  x0: number;
  y0: number;
  nx: number;
  ny: number;
  hx: number;
  hy: number;
  /** Speed per cell (m/s), -1 where solid; row-major, x fastest */
  speed: number[];
}

/** Vertical cut along a room's long axis through its centre. */
export interface SpeedSection {
  /** Plan axis the cut runs along, and the fixed coordinate of the other axis */
  axis: 'x' | 'y';
  at: number;
  from: number;
  nAlong: number;
  nz: number;
  hAlong: number;
  hz: number;
  speed: number[];
  /** In-plane components: along the cut and vertical (m/s) */
  along: number[];
  w: number[];
}

/**
 * Air movement everywhere in a studied room, for advecting smoke through the
 * actual flow. Stored as velocities on the faces of ~20 cm blocks (each the
 * average over the finer CFD faces it covers), so mass is conserved block by
 * block: interpolating each component between its own two faces gives a flow
 * that never leaks into walls and never piles air up in mid-room.
 */
export interface VelocityField {
  x0: number;
  y0: number;
  nx: number;
  ny: number;
  nz: number;
  h: [number, number, number];
  /** x-face velocities, (nx+1)·ny·nz, x fastest (m/s) */
  fx: number[];
  /** y-face velocities, nx·(ny+1)·nz */
  fy: number[];
  /** z-face velocities, nx·ny·(nz+1) */
  fz: number[];
  /** 1 where the block is solid (wall, ceiling void, equipment) */
  solid: number[];
  /**
   * True width / depth of the room's air (m). The last block can reach past it
   * when the room is not a whole number of blocks; beyond it is wall.
   */
  extent?: [number, number];
}

export interface FacilityResults {
  jobId: string;
  /** Rooms this run covered (null = the whole floor) */
  roomIds: string[] | null;
  doorMode: DoorMode;
  grid: { nx: number; ny: number; nz: number; hx: number; hy: number; hz: number; fluidCells: number };
  solver: { steps: number; residual: number; converged: boolean; seconds: number };
  flowBalance: { supplyM3h: number; extractDesignM3h: number; extractScale: number };
  statistics: { maxVelocity: number; avgVelocity: number };
  rooms: RoomFlowResult[];
  doors: DoorFlowResult[];
  streamlines: { id: string; roomId: string | null; points: number[]; speeds: number[] }[];
  vectors: { p: [number, number, number]; d: [number, number, number]; m: number }[];
  deadZones: { roomId: string | null; x: number; y: number; z: number; volume: number; speed: number }[];
  slice: SpeedSlice;
  section?: SpeedSection;
  /** Room studies only */
  field?: VelocityField;
  warnings: string[];
}

export type FacilityJobStatus = 'queued' | 'meshing' | 'running' | 'postprocessing' | 'completed' | 'failed';

export interface FacilityJob {
  id: string;
  status: FacilityJobStatus;
  progress: number;
  message: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
