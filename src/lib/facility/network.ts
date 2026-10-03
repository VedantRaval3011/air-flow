/**
 * Room pressure network ("zonal" model, the approach used by CONTAM and by
 * cleanroom pressure-cascade studies).
 *
 * Nodes: every room, plus a supply plenum and a return plenum for each AHU;
 * outdoors is the 0 Pa reference. Links:
 *   - supply branch   AHU supply plenum → damper → duct → HEPA / diffuser → room
 *   - return branch   room → riser grille → duct → damper → AHU return plenum
 *   - door            room ↔ room / outdoors; crack leakage when shut, full
 *                     orifice when open
 *   - louvre          make-up path for exhaust-only rooms
 *   - fresh air       outdoors → FA damper → AHU mixing box (return plenum)
 *   - bleed           relief from the return side, tied to AHU speed
 *   - fan             centrifugal curve scaled by VFD frequency (affinity laws)
 *
 * `buildNetwork` commissions the system: it sets the damper positions so that,
 * with every door shut and the VFDs at the design frequency, the rooms get
 * their RDS supply air and settle at their RDS pressures. `solveNetwork` then
 * finds the pressures and flows for any door / damper / VFD / filter-loading
 * state in a few milliseconds, which is what lets the viewer react to a door
 * being opened in real time.
 */

import { Facility, FacilityDoor, FacilityRoom, TerminalCode } from './types';
import { CFM_TO_M3S, TERMINALS } from './geometry';

const RHO = 1.2; // kg/m³
const CD = 0.65; // orifice discharge coefficient for doors and louvres

/** Design VFD frequency the system is balanced at (Hz). */
export const DESIGN_HZ = 45;
const MOTOR_RPM_50HZ = 1450;
const FAN_EFFICIENCY = 0.65;
const MOTOR_EFFICIENCY = 0.9;

/** Pressure drops at design flow used to size the components (Pa). */
const HEPA_CLEAN_DP = 200; // at rated flow; final (dirty) HEPA ≈ 2.5× this
const DIFFUSER_DP = 20;
const SUPPLY_DUCT_DP = 50;
const SUPPLY_DAMPER_OPEN_DP = 15;
const RISER_GRILLE_DP = 15;
const RETURN_DUCT_DP = 40;
const RETURN_DAMPER_OPEN_DP = 10;
const AHU_INTERNAL_DP = 250; // pre + fine filter + coil at rated flow
/** Most-open damper on each AHU after balancing (the index branch). */
const INDEX_DAMPER_OPEN = 0.65;
const FA_DAMPER_DESIGN_OPEN = 0.6;
const BLEED_DAMPER_DESIGN_OPEN = 0.6;
/** Fraction of a room's design supply its return may fall to when balancing. */
const MIN_RETURN_FRACTION = 0.03;
/** Door perimeter gap when shut (m). */
const DOOR_GAP = 0.002;

// ============= Controls and results =============

export interface AhuControl {
  running: boolean;
  /** VFD output frequency (Hz) */
  hz: number;
  freshAirPct: number;
  bleedPct: number;
  /** 0 = clean HEPA / filters, 100 = at final (change-out) resistance */
  filterLoadingPct: number;
}

export interface HvacControls {
  ahu: Record<string, AhuControl>;
  supplyDamperPct: Record<string, number>;
  returnDamperPct: Record<string, number>;
  doorsOpen: Record<string, boolean>;
}

export type PressureAlarm = 'ok' | 'low' | 'high' | 'none';
export type DoorStatus = 'ok' | 'open' | 'low-dp' | 'reversed' | 'n/a';

export interface RoomState {
  roomId: string;
  pressurePa: number;
  designPa: number | null;
  alarm: PressureAlarm;
  supplyCfm: number;
  returnCfm: number;
  exhaustCfm: number;
  /** Net air leaving through doors and louvres (CFM) */
  leakageOutCfm: number;
  achievedAcph: number;
  supplyDamperPct: number | null;
  returnDamperPct: number | null;
  /**
   * Supply branch: static in the AHU supply main at the take-off, and the
   * pressure the balancing damper is burning.
   */
  supplyBranch: { mainStaticPa: number; damperDpPa: number } | null;
  /**
   * HEPA terminal: static in the terminal plenum (box above the filter,
   * relative to outdoors) and the drop across the filter media (terminal ΔP,
   * what a magnehelic across the HEPA reads).
   */
  hepa: { count: number; cfmEach: number; plenumStaticPa: number; filterDpPa: number; faceVelocity: number } | null;
  /** Return risers: flow per riser, grille face velocity and pressure drops */
  riser: { count: number; cfmEach: number; faceVelocity: number; grilleDpPa: number; damperDpPa: number } | null;
}

export interface DoorState {
  doorId: string;
  open: boolean;
  /** P(rooms[0]) − P(rooms[1] or outdoors) */
  dpPa: number;
  designDpPa: number;
  /** Flow from rooms[0] to rooms[1] (CFM) */
  flowCfm: number;
  status: DoorStatus;
}

export interface AhuState {
  id: string;
  kind: 'ahu' | 'exhaust';
  running: boolean;
  hz: number;
  motorRpm: number;
  motorKw: number;
  ratedCfm: number;
  supplyCfm: number;
  returnCfm: number;
  freshAirCfm: number;
  bleedCfm: number;
  /** Static pressures relative to outdoors (Pa) */
  supplyStaticPa: number;
  returnStaticPa: number;
  fanDpPa: number;
  internalDpPa: number;
  freshAirPct: number;
  bleedPct: number;
  filterLoadingPct: number;
  designSupplyCfm: number;
  /** VFD output as a share of 50 Hz */
  vfdSpeedPct: number;
  /** Estimated motor current at 415 V, pf 0.85 (A) */
  motorCurrentA: number;
  /** Mean drop across the HEPA filters this AHU feeds (Pa); null without HEPAs */
  hepaFilterDpPa: number | null;
}

export interface NetworkState {
  rooms: RoomState[];
  doors: DoorState[];
  ahus: AhuState[];
  converged: boolean;
  iterations: number;
  /** Largest mass imbalance left at any node (CFM) */
  residualCfm: number;
}

// ============= Model =============

interface Branch {
  roomId: string;
  ahuId: string;
  kind: 'supply' | 'return';
  /** Fixed quadratic resistance (duct + grille / diffuser), Pa/(m³/s)² */
  rFixed: number;
  /** Fully open damper resistance, Pa/(m³/s)² */
  rDamperOpen: number;
  /** Linear filter resistance when clean, Pa/(m³/s) (HEPA only) */
  kFilter: number;
  /** HEPA face area, m² (HEPA only) */
  hepaArea: number;
  designFlow: number;
  /** Terminals on the branch (HEPAs / diffusers, or risers / return diffusers) and their face area */
  terminals: number;
  terminalArea: number;
  /** Share of rFixed that is the grille (return branches) */
  grilleShare: number;
}

interface Leak {
  id: string;
  doorId?: string;
  a: string;
  b: string | null;
  areaShut: number;
  areaOpen: number;
}

interface AhuModel {
  id: string;
  kind: 'ahu' | 'exhaust';
  ratedFlow: number;
  qMax: number;
  p0: number;
  rInternal: number;
  rFreshAirOpen: number;
  bleedDesign: number;
  exhaustDesign: number;
  exhaustRooms: { roomId: string; share: number }[];
  designSupply: number;
}

export interface NetworkModel {
  roomIds: string[];
  rooms: Map<string, FacilityRoom>;
  branches: Branch[];
  leaks: Leak[];
  ahus: AhuModel[];
  design: HvacControls;
  designPressures: Record<string, number>;
  /** Unknowns: room pressures then (supply, return) plenum pressure per AHU */
  initial: Float64Array;
  /** Commissioning notes: where the RDS figures cannot all be met */
  warnings: string[];
}

const cfm = (q: number) => q / CFM_TO_M3S;

function leakArea(door: FacilityDoor): number {
  // ~2 mm perimeter gap (sealed cleanroom leaf), plus the meeting stile of a
  // double leaf: ≈0.01 m² for a single door, the usual design figure.
  const perimeter = 2 * door.height + door.width + (door.width > 1.2 ? door.height : 0);
  return DOOR_GAP * perimeter;
}

function terminalCount(room: FacilityRoom, codes: TerminalCode[]): number {
  return codes.reduce((n, c) => n + (room.hvac.terminals[c] ?? 0), 0);
}

function ratedFlow(room: FacilityRoom, codes: TerminalCode[]): number {
  return codes.reduce((q, c) => q + (room.hvac.terminals[c] ?? 0) * TERMINALS[c].ratedCfm * CFM_TO_M3S, 0);
}

const HEPA_CODES: TerminalCode[] = ['H1', 'H2', 'H3'];
const DIFFUSER_CODES: TerminalCode[] = ['SD1', 'SD2', 'SD4'];
const RETURN_CODES: TerminalCode[] = ['R1', 'R2', 'R3', 'RD1', 'RD2', 'RD4'];

export function buildNetwork(facility: Facility): NetworkModel {
  const warnings: string[] = [];
  const rooms = new Map(facility.rooms.map((r) => [r.id, r]));
  const roomIds = facility.rooms.map((r) => r.id);
  const target = (id: string) => rooms.get(id)?.hvac.pressurePa ?? 0;

  // --- Leakage paths -------------------------------------------------------
  const leaks: Leak[] = facility.doors.map((d) => ({
    id: d.id,
    doorId: d.id,
    a: d.rooms[0],
    b: d.rooms[1],
    areaShut: leakArea(d),
    areaOpen: d.width * d.height,
  }));

  // Exhaust-only rooms draw make-up air through transfer grilles / a door louvre.
  for (const room of facility.rooms) {
    const hv = room.hvac;
    if (hv.exhaustCfm <= 0 || hv.supplyCfm > 0) continue;
    const grilles = (['SG1', 'SG2', 'SG3'] as TerminalCode[]).reduce(
      (a, c) => a + (hv.terminals[c] ?? 0) * TERMINALS[c].width * TERMINALS[c].depth,
      0
    );
    const door = facility.doors.find((d) => d.rooms[0] === room.id && d.rooms[1] === null);
    const louvre = grilles > 0 ? grilles : door ? (door.width - 0.2) * 0.6 : 0.2;
    leaks.push({ id: `louvre-${room.id}`, a: room.id, b: null, areaShut: louvre * 0.5, areaOpen: louvre * 0.5 });
  }

  // Door flows at the design pressures with every door shut.
  const leakFlow = (leak: Leak, pa: number, pb: number, open: boolean) =>
    orificeFlow(pa - pb, open ? leak.areaOpen : leak.areaShut);
  const designLeakOut = new Map<string, number>();
  for (const leak of leaks) {
    const q = leakFlow(leak, target(leak.a), leak.b ? target(leak.b) : 0, false);
    designLeakOut.set(leak.a, (designLeakOut.get(leak.a) ?? 0) + q);
    if (leak.b) designLeakOut.set(leak.b, (designLeakOut.get(leak.b) ?? 0) - q);
  }

  // --- Branches, balanced per AHU ------------------------------------------
  const branches: Branch[] = [];
  const design: HvacControls = { ahu: {}, supplyDamperPct: {}, returnDamperPct: {}, doorsOpen: {} };
  const ahus: AhuModel[] = [];
  const plenum: Record<string, { ps: number; pr: number }> = {};

  for (const handler of facility.airHandlers) {
    const served = facility.rooms.filter((r) => r.hvac.ahu === handler.id);

    if (handler.kind === 'exhaust') {
      const total = served.reduce((a, r) => a + r.hvac.exhaustCfm, 0) * CFM_TO_M3S;
      ahus.push({
        id: handler.id,
        kind: 'exhaust',
        ratedFlow: handler.ratedCfm * CFM_TO_M3S,
        qMax: 0,
        p0: 0,
        rInternal: 0,
        rFreshAirOpen: 0,
        bleedDesign: 0,
        exhaustDesign: total,
        exhaustRooms: served.map((r) => ({ roomId: r.id, share: total > 0 ? (r.hvac.exhaustCfm * CFM_TO_M3S) / total : 0 })),
        designSupply: 0,
      });
      design.ahu[handler.id] = { running: true, hz: DESIGN_HZ, freshAirPct: 0, bleedPct: 0, filterLoadingPct: 0 };
      continue;
    }

    // Supply side: size fixed resistances from design flow, then set the
    // supply plenum so the index branch damper is INDEX_DAMPER_OPEN open.
    const supply = served
      .filter((r) => r.hvac.supplyCfm > 0)
      .map((room) => {
        const q = room.hvac.supplyCfm * CFM_TO_M3S;
        const hepaRated = ratedFlow(room, HEPA_CODES);
        const isHepa = hepaRated > 0;
        const kFilter = isHepa ? HEPA_CLEAN_DP / hepaRated : 0;
        const diffRated = ratedFlow(room, DIFFUSER_CODES) || q;
        const rTerminal = isHepa ? 0 : DIFFUSER_DP / (diffRated * diffRated);
        const hepaArea = HEPA_CODES.reduce(
          (a, c) => a + (room.hvac.terminals[c] ?? 0) * TERMINALS[c].width * TERMINALS[c].depth,
          0
        );
        const fixedDp = SUPPLY_DUCT_DP + rTerminal * q * q + kFilter * q;
        return { room, q, kFilter, rTerminal, hepaArea, fixedDp };
      });
    const ps = Math.max(
      ...supply.map((s) => target(s.room.id) + s.fixedDp + SUPPLY_DAMPER_OPEN_DP / (INDEX_DAMPER_OPEN * INDEX_DAMPER_OPEN)),
      50
    );
    for (const s of supply) {
      const rOpen = SUPPLY_DAMPER_OPEN_DP / (s.q * s.q);
      const damperDp = ps - target(s.room.id) - s.fixedDp;
      const theta = Math.min(1, Math.sqrt(SUPPLY_DAMPER_OPEN_DP / Math.max(damperDp, 1e-3)));
      branches.push({
        roomId: s.room.id,
        ahuId: handler.id,
        kind: 'supply',
        rFixed: SUPPLY_DUCT_DP / (s.q * s.q) + s.rTerminal,
        rDamperOpen: rOpen,
        kFilter: s.kFilter,
        hepaArea: s.hepaArea,
        designFlow: s.q,
        terminals: terminalCount(s.room, s.hepaArea > 0 ? HEPA_CODES : DIFFUSER_CODES),
        terminalArea: s.hepaArea,
        grilleShare: 0,
      });
      design.supplyDamperPct[s.room.id] = theta * 100;
    }

    // Return side: whatever the room does not lose through its doors at the
    // design pressures has to come back through the risers.
    const returns = served
      .filter((r) => terminalCount(r, RETURN_CODES) > 0 && r.hvac.supplyCfm > 0)
      .map((room) => {
        const qs = room.hvac.supplyCfm * CFM_TO_M3S;
        let q = qs - (designLeakOut.get(room.id) ?? 0);
        if (q < MIN_RETURN_FRACTION * qs) {
          warnings.push(
            `${room.name}: at ${room.hvac.pressurePa} Pa its doors leak ${Math.round(cfm(designLeakOut.get(room.id) ?? 0))} CFM against ${Math.round(room.hvac.supplyCfm)} CFM supply, so the design pressure cannot be held with the returns shut down.`
          );
          q = MIN_RETURN_FRACTION * qs;
        }
        return { room, q };
      });
    const pr = Math.min(
      ...returns.map((r) => target(r.room.id) - RISER_GRILLE_DP - RETURN_DUCT_DP - RETURN_DAMPER_OPEN_DP / (INDEX_DAMPER_OPEN * INDEX_DAMPER_OPEN)),
      -50
    );
    for (const r of returns) {
      const damperDp = target(r.room.id) - RISER_GRILLE_DP - RETURN_DUCT_DP - pr;
      const theta = Math.min(1, Math.sqrt(RETURN_DAMPER_OPEN_DP / Math.max(damperDp, 1e-3)));
      branches.push({
        roomId: r.room.id,
        ahuId: handler.id,
        kind: 'return',
        rFixed: (RISER_GRILLE_DP + RETURN_DUCT_DP) / (r.q * r.q),
        rDamperOpen: RETURN_DAMPER_OPEN_DP / (r.q * r.q),
        kFilter: 0,
        hepaArea: 0,
        designFlow: r.q,
        terminals: terminalCount(r.room, RETURN_CODES),
        terminalArea: RETURN_CODES.reduce(
          (a, c) => a + (r.room.hvac.terminals[c] ?? 0) * TERMINALS[c].width * TERMINALS[c].depth,
          0
        ),
        grilleShare: RISER_GRILLE_DP / (RISER_GRILLE_DP + RETURN_DUCT_DP),
      });
      design.returnDamperPct[r.room.id] = theta * 100;
    }

    // AHU: fresh air makes up what the rooms leak plus the bleed.
    const qSupply = supply.reduce((a, s) => a + s.q, 0);
    const qReturn = returns.reduce((a, r) => a + r.q, 0);
    let bleed = handler.bleedCfm * CFM_TO_M3S;
    let freshAir = qSupply - qReturn + bleed;
    if (freshAir < 0.02 * qSupply) {
      bleed += 0.02 * qSupply - freshAir;
      freshAir = 0.02 * qSupply;
    }
    const rFresh = (0 - pr) / (freshAir * freshAir);

    const rated = Math.max(handler.ratedCfm * CFM_TO_M3S, qSupply);
    const qMax = 1.5 * rated;
    const rInternal = AHU_INTERNAL_DP / (rated * rated);
    const dpRequired = ps - pr + rInternal * qSupply * qSupply;
    const speed = DESIGN_HZ / 50;
    const p0 = dpRequired / (speed * speed - (qSupply / qMax) ** 2);

    ahus.push({
      id: handler.id,
      kind: 'ahu',
      ratedFlow: rated,
      qMax,
      p0,
      rInternal,
      rFreshAirOpen: rFresh * FA_DAMPER_DESIGN_OPEN * FA_DAMPER_DESIGN_OPEN,
      bleedDesign: bleed,
      exhaustDesign: 0,
      exhaustRooms: [],
      designSupply: qSupply,
    });
    plenum[handler.id] = { ps, pr };
    design.ahu[handler.id] = {
      running: true,
      hz: DESIGN_HZ,
      freshAirPct: FA_DAMPER_DESIGN_OPEN * 100,
      bleedPct: BLEED_DAMPER_DESIGN_OPEN * 100,
      filterLoadingPct: 0,
    };
  }

  for (const d of facility.doors) design.doorsOpen[d.id] = false;

  const designPressures: Record<string, number> = {};
  for (const r of facility.rooms) designPressures[r.id] = r.hvac.pressurePa;

  const initial = new Float64Array(roomIds.length + 2 * ahus.length);
  roomIds.forEach((id, i) => (initial[i] = target(id)));
  ahus.forEach((a, k) => {
    initial[roomIds.length + 2 * k] = plenum[a.id]?.ps ?? 0;
    initial[roomIds.length + 2 * k + 1] = plenum[a.id]?.pr ?? 0;
  });

  const model: NetworkModel = { roomIds, rooms, branches, leaks, ahus, design, designPressures, initial, warnings };
  balance(model, facility);
  return model;
}

/**
 * Air balancing, as done at commissioning: the first sizing pass lands every
 * room within a few pascals, then each room's return damper is trimmed until
 * the room sits at its RDS pressure. Rooms whose damper runs out of travel
 * cannot reach the design pressure with the RDS supply, which is reported.
 */
function balance(model: NetworkModel, facility: Facility): void {
  const withReturn = new Set(model.branches.filter((b) => b.kind === 'return').map((b) => b.roomId));
  let x = model.initial;
  let state: NetworkState | null = null;

  for (let pass = 0; pass < 60; pass++) {
    const solved = solveNetwork(model, model.design, x);
    x = solved.x;
    state = solved.state;
    let worst = 0;
    for (const r of state.rooms) {
      if (r.designPa === null || !withReturn.has(r.roomId)) continue;
      const error = r.pressurePa - r.designPa;
      const pct = model.design.returnDamperPct[r.roomId];
      // Too high → open the return; too low → throttle it.
      const next = Math.max(2, Math.min(100, pct * (1 + 0.04 * Math.max(-10, Math.min(10, error)))));
      if (Math.abs(next - pct) > 0.01) worst = Math.max(worst, Math.abs(error));
      model.design.returnDamperPct[r.roomId] = next;
    }
    if (worst < 0.3) break;
  }
  model.initial = x;
  if (!state) return;

  for (const r of state.rooms) {
    const room = model.rooms.get(r.roomId) as FacilityRoom;
    if (r.designPa === null) continue;
    const pct = model.design.returnDamperPct[r.roomId];
    if (Math.abs(r.pressurePa - r.designPa) > 1.5) {
      model.warnings.push(
        `${room.name}: balances at ${r.pressurePa} Pa instead of ${r.designPa} Pa — its return damper is ${pct !== undefined && pct <= 2.5 ? 'fully throttled' : 'at its limit'}; the supply cannot cover the door leakage at that pressure.`
      );
    }
    const rds = room.hvac.returnCfm;
    if (withReturn.has(r.roomId) && Math.abs(r.returnCfm - rds) > Math.max(0.25 * rds, 60)) {
      model.warnings.push(
        `${room.name}: holding ${r.designPa} Pa with shut doors takes ≈${r.returnCfm} CFM return; the RDS lists ${Math.round(rds)} CFM.`
      );
    }
  }
  for (const a of state.ahus) {
    const handler = facility.airHandlers.find((h) => h.id === a.id);
    if (!handler || handler.kind !== 'ahu') continue;
    if (Math.abs(a.freshAirCfm - handler.freshAirCfm) > Math.max(0.3 * handler.freshAirCfm, 50)) {
      model.warnings.push(
        `${a.id}: pressurisation alone (door leakage + bleed) takes ≈${a.freshAirCfm} CFM fresh air against ${Math.round(handler.freshAirCfm)} CFM in the RDS. The RDS figure also covers occupant ventilation, so running it needs matching relief/bleed or the rooms will over-pressurise.`
      );
    }
  }
}

// ============= Flow laws =============

/**
 * Flow through a path with ΔP = R·q|q| + k·q. The small linear term keeps the
 * law smooth through zero so Newton's method behaves.
 */
function pathFlow(dp: number, r: number, k: number): number {
  const kk = Math.max(k, Math.sqrt(0.0005 * r));
  if (r <= 0) return dp / kk;
  const q = (-kk + Math.sqrt(kk * kk + 4 * r * Math.abs(dp))) / (2 * r);
  return dp >= 0 ? q : -q;
}

function orificeFlow(dp: number, area: number): number {
  const r = RHO / (2 * (CD * area) ** 2);
  return pathFlow(dp, r, 0);
}

function damperResistance(openPct: number, rOpen: number): number {
  const theta = Math.max(0.02, Math.min(1, openPct / 100));
  return rOpen / (theta * theta);
}

// ============= Solve =============

interface Evaluation {
  residual: Float64Array;
  branchFlow: Float64Array;
  leakFlow: Float64Array;
  ahuFlows: { supply: number; ret: number; freshAir: number; bleed: number; fanDp: number; exhaust: number }[];
}

function evaluate(model: NetworkModel, controls: HvacControls, x: Float64Array): Evaluation {
  const nRooms = model.roomIds.length;
  const index = new Map(model.roomIds.map((id, i) => [id, i]));
  const ahuIndex = new Map(model.ahus.map((a, k) => [a.id, k]));
  const residual = new Float64Array(x.length);
  const branchFlow = new Float64Array(model.branches.length);
  const leakFlow = new Float64Array(model.leaks.length);
  const ahuFlows = model.ahus.map(() => ({ supply: 0, ret: 0, freshAir: 0, bleed: 0, fanDp: 0, exhaust: 0 }));

  model.branches.forEach((b, i) => {
    const room = index.get(b.roomId) as number;
    const k = ahuIndex.get(b.ahuId) as number;
    const ctl = controls.ahu[b.ahuId];
    const pRoom = x[room];
    if (b.kind === 'supply') {
      const ps = x[nRooms + 2 * k];
      const pct = controls.supplyDamperPct[b.roomId] ?? 100;
      const loading = 1 + 1.5 * ((ctl?.filterLoadingPct ?? 0) / 100);
      const q = pathFlow(ps - pRoom, b.rFixed + damperResistance(pct, b.rDamperOpen), b.kFilter * loading);
      branchFlow[i] = q;
      residual[room] += q;
      ahuFlows[k].supply += q;
    } else {
      const pr = x[nRooms + 2 * k + 1];
      const pct = controls.returnDamperPct[b.roomId] ?? 100;
      const q = pathFlow(pRoom - pr, b.rFixed + damperResistance(pct, b.rDamperOpen), 0);
      branchFlow[i] = q;
      residual[room] -= q;
      ahuFlows[k].ret += q;
    }
  });

  model.leaks.forEach((leak, i) => {
    const a = index.get(leak.a) as number;
    const pa = x[a];
    const pb = leak.b ? x[index.get(leak.b) as number] : 0;
    const open = leak.doorId ? Boolean(controls.doorsOpen[leak.doorId]) : true;
    const q = orificeFlow(pa - pb, open ? leak.areaOpen : leak.areaShut);
    leakFlow[i] = q;
    residual[a] -= q;
    if (leak.b) residual[index.get(leak.b) as number] += q;
  });

  model.ahus.forEach((ahu, k) => {
    const ctl = controls.ahu[ahu.id];
    const running = ctl?.running ?? true;
    const speed = running ? (ctl?.hz ?? DESIGN_HZ) / 50 : 0;
    const iS = nRooms + 2 * k;
    const iR = iS + 1;

    if (ahu.kind === 'exhaust') {
      const q = ahu.exhaustDesign * (speed / (DESIGN_HZ / 50));
      ahuFlows[k].exhaust = q;
      for (const er of ahu.exhaustRooms) residual[index.get(er.roomId) as number] -= q * er.share;
      // Exhaust fans have no plenum unknowns: pin them.
      residual[iS] = x[iS];
      residual[iR] = x[iR];
      return;
    }

    const f = ahuFlows[k];
    const ps = x[iS];
    const pr = x[iR];
    const loading = 1 + 1.5 * ((ctl?.filterLoadingPct ?? 0) / 100);
    const fa = pathFlow(0 - pr, damperResistance(ctl?.freshAirPct ?? 60, ahu.rFreshAirOpen), 0);
    const bleed = running ? ahu.bleedDesign * ((ctl?.bleedPct ?? 60) / (BLEED_DAMPER_DESIGN_OPEN * 100)) * (speed / (DESIGN_HZ / 50)) : 0;
    f.freshAir = fa;
    f.bleed = bleed;

    if (running) {
      // Fan curve with affinity laws: ΔP = p0·[(f/50)² − (Q/Qmax)²].
      const q = f.supply;
      const fanDp = ahu.p0 * (speed * speed - Math.sign(q) * (q / ahu.qMax) ** 2);
      f.fanDp = fanDp;
      residual[iS] = (fanDp - ahu.rInternal * loading * q * Math.abs(q) - (ps - pr)) / 100;
    } else {
      // Stopped fan with its dampers shut: no flow through the unit.
      residual[iS] = f.supply;
    }
    // Return plenum / mixing box: in = out.
    residual[iR] = f.ret + fa - bleed - f.supply;
  });

  return { residual, branchFlow, leakFlow, ahuFlows };
}

function norm(r: Float64Array): number {
  let m = 0;
  for (let i = 0; i < r.length; i++) m = Math.max(m, Math.abs(r[i]));
  return m;
}

/** Dense LU solve with partial pivoting (the system is ~50 unknowns). */
function solveLinear(a: Float64Array[], b: Float64Array): Float64Array | null {
  const n = b.length;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    if (Math.abs(a[pivot][col]) < 1e-14) return null;
    if (pivot !== col) {
      [a[pivot], a[col]] = [a[col], a[pivot]];
      [b[pivot], b[col]] = [b[col], b[pivot]];
    }
    for (let r = col + 1; r < n; r++) {
      const f = a[r][col] / a[col][col];
      if (f === 0) continue;
      for (let c = col; c < n; c++) a[r][c] -= f * a[col][c];
      b[r] -= f * b[col];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let c = r + 1; c < n; c++) s -= a[r][c] * x[c];
    x[r] = s / a[r][r];
  }
  return x;
}

export interface SolveNetworkResult {
  state: NetworkState;
  /** Unknown vector at the solution, to warm-start the next solve */
  x: Float64Array;
}

export function solveNetwork(model: NetworkModel, controls: HvacControls, warmStart?: Float64Array): SolveNetworkResult {
  const n = model.initial.length;
  let x = Float64Array.from(warmStart && warmStart.length === n ? warmStart : model.initial);
  let evalX = evaluate(model, controls, x);
  let iterations = 0;
  const tol = 1e-7;

  for (; iterations < 80 && norm(evalX.residual) > tol; iterations++) {
    // Finite-difference Jacobian.
    const jac: Float64Array[] = Array.from({ length: n }, () => new Float64Array(n));
    for (let j = 0; j < n; j++) {
      const h = 1e-4 * Math.max(1, Math.abs(x[j]));
      const xp = Float64Array.from(x);
      xp[j] += h;
      const rp = evaluate(model, controls, xp).residual;
      for (let i = 0; i < n; i++) jac[i][j] = (rp[i] - evalX.residual[i]) / h;
    }
    const step = solveLinear(jac, Float64Array.from(evalX.residual, (v) => -v));
    if (!step) break;

    // Backtracking line search on the residual norm, with a cap on the
    // pressure change per iteration so a wild first step cannot diverge.
    let maxStep = 0;
    for (let i = 0; i < n; i++) maxStep = Math.max(maxStep, Math.abs(step[i]));
    let lambda = Math.min(1, 200 / Math.max(maxStep, 1e-12));
    const base = norm(evalX.residual);
    let accepted = false;
    for (let tries = 0; tries < 30; tries++, lambda *= 0.5) {
      const trial = Float64Array.from(x, (v, i) => v + lambda * step[i]);
      const e = evaluate(model, controls, trial);
      if (norm(e.residual) < base || tries === 29) {
        x = trial;
        evalX = e;
        accepted = true;
        break;
      }
    }
    if (!accepted) break;
  }

  return { state: buildState(model, controls, x, evalX, iterations), x };
}

function buildState(
  model: NetworkModel,
  controls: HvacControls,
  x: Float64Array,
  ev: Evaluation,
  iterations: number
): NetworkState {
  const nRooms = model.roomIds.length;
  const index = new Map(model.roomIds.map((id, i) => [id, i]));

  let residualCfm = 0;
  for (let i = 0; i < nRooms; i++) residualCfm = Math.max(residualCfm, Math.abs(cfm(ev.residual[i])));

  const supply = new Map<string, number>();
  const ret = new Map<string, number>();
  const hepa = new Map<string, RoomState['hepa']>();
  const supplyBranch = new Map<string, RoomState['supplyBranch']>();
  const riser = new Map<string, RoomState['riser']>();
  const ahuIndex = new Map(model.ahus.map((a, k) => [a.id, k]));
  model.branches.forEach((b, i) => {
    const q = ev.branchFlow[i];
    const k = ahuIndex.get(b.ahuId) as number;
    if (b.kind === 'supply') {
      supply.set(b.roomId, (supply.get(b.roomId) ?? 0) + q);
      const damperDp = damperResistance(controls.supplyDamperPct[b.roomId] ?? 100, b.rDamperOpen) * q * Math.abs(q);
      supplyBranch.set(b.roomId, { mainStaticPa: round(x[nRooms + 2 * k], 1), damperDpPa: round(damperDp, 1) });
      if (b.kFilter > 0) {
        const loading = 1 + 1.5 * ((controls.ahu[b.ahuId]?.filterLoadingPct ?? 0) / 100);
        const filterDp = b.kFilter * loading * q;
        hepa.set(b.roomId, {
          count: b.terminals,
          cfmEach: round(cfm(q) / Math.max(1, b.terminals), 0),
          plenumStaticPa: round(x[index.get(b.roomId) as number] + filterDp, 1),
          filterDpPa: round(filterDp, 1),
          faceVelocity: round(b.hepaArea > 0 ? q / b.hepaArea : 0, 3),
        });
      }
    } else {
      ret.set(b.roomId, (ret.get(b.roomId) ?? 0) + q);
      const damperDp = damperResistance(controls.returnDamperPct[b.roomId] ?? 100, b.rDamperOpen) * q * Math.abs(q);
      riser.set(b.roomId, {
        count: b.terminals,
        cfmEach: round(cfm(q) / Math.max(1, b.terminals), 0),
        faceVelocity: round(b.terminalArea > 0 ? q / b.terminalArea : 0, 2),
        grilleDpPa: round(b.rFixed * b.grilleShare * q * Math.abs(q), 1),
        damperDpPa: round(damperDp, 1),
      });
    }
  });

  const exhaust = new Map<string, number>();
  model.ahus.forEach((a, k) => {
    for (const er of a.exhaustRooms) exhaust.set(er.roomId, (exhaust.get(er.roomId) ?? 0) + ev.ahuFlows[k].exhaust * er.share);
  });

  const leakOut = new Map<string, number>();
  model.leaks.forEach((leak, i) => {
    const q = ev.leakFlow[i];
    leakOut.set(leak.a, (leakOut.get(leak.a) ?? 0) + q);
    if (leak.b) leakOut.set(leak.b, (leakOut.get(leak.b) ?? 0) - q);
  });

  const rooms: RoomState[] = model.roomIds.map((id, i) => {
    const room = model.rooms.get(id) as FacilityRoom;
    const p = x[i];
    const classified = room.hvac.areaClass !== 'NC';
    const designPa = classified ? room.hvac.pressurePa : null;
    let alarm: PressureAlarm = 'none';
    if (designPa !== null) {
      const band = Math.max(5, 0.25 * designPa);
      alarm = p < designPa - band ? 'low' : p > designPa + band ? 'high' : 'ok';
    }
    const volume = room.rects.reduce((a, r) => a + (r.x1 - r.x0) * (r.y1 - r.y0), 0) * room.height;
    const q = supply.get(id) ?? 0;
    return {
      roomId: id,
      pressurePa: round(p, 1),
      designPa,
      alarm,
      supplyCfm: round(cfm(q), 0),
      returnCfm: round(cfm(ret.get(id) ?? 0), 0),
      exhaustCfm: round(cfm(exhaust.get(id) ?? 0), 0),
      leakageOutCfm: round(cfm(leakOut.get(id) ?? 0), 0),
      achievedAcph: round((q * 3600) / Math.max(volume, 1e-6), 1),
      supplyDamperPct: controls.supplyDamperPct[id] ?? null,
      returnDamperPct: controls.returnDamperPct[id] ?? null,
      supplyBranch: supplyBranch.get(id) ?? null,
      hepa: hepa.get(id) ?? null,
      riser: riser.get(id) ?? null,
    };
  });

  const doors: DoorState[] = [];
  model.leaks.forEach((leak, i) => {
    if (!leak.doorId) return;
    const pa = x[index.get(leak.a) as number];
    const pb = leak.b ? x[index.get(leak.b) as number] : 0;
    const dp = pa - pb;
    const designDp = model.designPressures[leak.a] - (leak.b ? model.designPressures[leak.b] : 0);
    const open = Boolean(controls.doorsOpen[leak.doorId]);
    let status: DoorStatus = 'n/a';
    if (open) status = 'open';
    else if (Math.abs(designDp) >= 5) {
      if (Math.sign(dp) !== Math.sign(designDp) && Math.abs(dp) > 0.5) status = 'reversed';
      else if (Math.abs(dp) < Math.min(Math.abs(designDp) * 0.5, 7.5)) status = 'low-dp';
      else status = 'ok';
    }
    doors.push({
      doorId: leak.doorId,
      open,
      dpPa: round(dp, 1),
      designDpPa: round(designDp, 1),
      flowCfm: round(cfm(ev.leakFlow[i]), 0),
      status,
    });
  });

  const meanHepaDp = (ahuId: string): number | null => {
    const dps = model.branches
      .filter((b) => b.ahuId === ahuId && b.kind === 'supply' && b.kFilter > 0)
      .map((b) => hepa.get(b.roomId)?.filterDpPa ?? 0);
    return dps.length ? round(dps.reduce((a, v) => a + v, 0) / dps.length, 1) : null;
  };

  const ahus: AhuState[] = model.ahus.map((a, k) => {
    const ctl = controls.ahu[a.id];
    const f = ev.ahuFlows[k];
    const running = ctl?.running ?? true;
    const hz = running ? ctl?.hz ?? DESIGN_HZ : 0;
    const loading = 1 + 1.5 * ((ctl?.filterLoadingPct ?? 0) / 100);
    const flow = a.kind === 'exhaust' ? f.exhaust : f.supply;
    const internal = a.kind === 'exhaust' ? 0 : a.rInternal * loading * flow * flow;
    // Exhaust fans are not modelled hydraulically; take a nominal 250 Pa.
    const fanDp = a.kind === 'exhaust' ? (running ? 250 * (hz / DESIGN_HZ) ** 2 : 0) : f.fanDp;
    const kw = running ? (Math.max(flow, 0) * Math.max(fanDp, 0)) / (FAN_EFFICIENCY * MOTOR_EFFICIENCY) / 1000 : 0;
    return {
      id: a.id,
      kind: a.kind,
      running,
      hz: round(hz, 1),
      motorRpm: round((MOTOR_RPM_50HZ * hz) / 50, 0),
      motorKw: round(kw, 2),
      ratedCfm: round(cfm(a.kind === 'exhaust' ? a.exhaustDesign : a.ratedFlow), 0),
      supplyCfm: round(cfm(a.kind === 'exhaust' ? 0 : f.supply), 0),
      returnCfm: round(cfm(a.kind === 'exhaust' ? f.exhaust : f.ret), 0),
      freshAirCfm: round(cfm(f.freshAir), 0),
      bleedCfm: round(cfm(f.bleed), 0),
      supplyStaticPa: round(a.kind === 'exhaust' ? 0 : x[nRooms + 2 * k], 1),
      returnStaticPa: round(a.kind === 'exhaust' ? 0 : x[nRooms + 2 * k + 1], 1),
      fanDpPa: round(fanDp, 1),
      internalDpPa: round(internal, 1),
      freshAirPct: ctl?.freshAirPct ?? 0,
      bleedPct: ctl?.bleedPct ?? 0,
      filterLoadingPct: ctl?.filterLoadingPct ?? 0,
      designSupplyCfm: round(cfm(a.designSupply), 0),
      vfdSpeedPct: round((hz / 50) * 100, 0),
      motorCurrentA: round((kw * 1000) / (Math.sqrt(3) * 415 * 0.85), 1),
      hepaFilterDpPa: meanHepaDp(a.id),
    };
  });

  return {
    rooms,
    doors,
    ahus,
    converged: residualCfm < 0.5,
    iterations,
    residualCfm: round(residualCfm, 3),
  };
}

function round(v: number, d: number): number {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

/** Deep copy of a control set, so UI edits never mutate the design values. */
export function cloneControls(c: HvacControls): HvacControls {
  return {
    ahu: Object.fromEntries(Object.entries(c.ahu).map(([k, v]) => [k, { ...v }])),
    supplyDamperPct: { ...c.supplyDamperPct },
    returnDamperPct: { ...c.returnDamperPct },
    doorsOpen: { ...c.doorsOpen },
  };
}
