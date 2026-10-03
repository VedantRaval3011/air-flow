'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { indianaGroundFloor, ZONING_NOTES } from '@/lib/facility/presets/indianaGroundFloor';
import {
  computeContextWalls,
  computeWalls,
  placeTerminals,
  roomAt,
  AHU_COLORS,
  CLASS_COLORS,
  pressureColor,
} from '@/lib/facility/geometry';
import { AhuControl, buildNetwork, cloneControls, HvacControls, solveNetwork } from '@/lib/facility/network';
import { FacilityObject, FacilitySimulationOptions, TerminalMoves } from '@/lib/facility/types';
import { airAt, nearestDoor } from '@/lib/facility/tour';
import { combineResults } from '@/lib/facility/results';
import { SPEED_SCALE_MAX, speedGradientCss } from '@/lib/facility/colormap';
import type { ColorMode, PlayerPose, SceneLayers, TourRequest } from '@/components/facility/FacilityScene3D';
import { AhuCard, DoorList, RoomDetail, RoomTable } from '@/components/facility/panels';
import TourHud from '@/components/facility/TourHud';
import HvacCheck from '@/components/facility/HvacCheck';
import LayoutEditor from '@/components/facility/LayoutEditor';
import { useCfdRuns } from '@/components/facility/useCfdRuns';
import SmokePanel from '@/components/facility/SmokePanel';
import type { SmokeStats } from '@/components/facility/SmokeTest3D';
import { operatorSpot, pathShares, sinksFor, sourcesFor, traceAirPaths } from '@/lib/facility/smoke';
import { sinkColor } from '@/components/facility/AirPaths3D';

const FacilityScene3D = dynamic(() => import('@/components/facility/FacilityScene3D'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-cyan-500 border-t-transparent" />
    </div>
  ),
});

type Tab = 'rooms' | 'ahus' | 'doors' | 'cfd' | 'findings';

const facility = indianaGroundFloor;

export default function FacilityPage() {
  const walls = useMemo(() => computeWalls(facility), []);
  const contextWalls = useMemo(() => computeContextWalls(facility), []);
  const model = useMemo(() => buildNetwork(facility), []);

  // ----- Layout edits -----
  const [objects, setObjects] = useState<FacilityObject[]>(facility.objects);
  const [terminalMoves, setTerminalMoves] = useState<TerminalMoves>({});
  const [editMode, setEditMode] = useState(false);
  const [selectedObject, setSelectedObject] = useState<string | null>(null);
  const [selectedTerminal, setSelectedTerminal] = useState<string | null>(null);
  const terminals = useMemo(() => placeTerminals(facility, walls, terminalMoves), [walls, terminalMoves]);

  const moveObject = (id: string, x: number, y: number) =>
    setObjects((os) =>
      os.map((o) => (o.id === id ? { ...o, x: round2(x), y: round2(y), roomId: roomAt(facility, x, y)?.id ?? o.roomId } : o))
    );
  const moveTerminal = (id: string, x: number, y: number) => setTerminalMoves((m) => ({ ...m, [id]: { x: round2(x), y: round2(y) } }));

  // ----- Pressure network -----
  const [controls, setControls] = useState<HvacControls>(() => cloneControls(model.design));
  const network = useMemo(() => solveNetwork(model, controls).state, [model, controls]);

  const [tab, setTab] = useState<Tab>('rooms');
  const [colorMode, setColorMode] = useState<ColorMode>('pressure');
  const [layers, setLayers] = useState<SceneLayers>({
    walls: 'full',
    labels: true,
    terminals: true,
    doorDp: true,
    streamlines: true,
    particles: true,
    vectors: false,
    deadZones: false,
    speedMap: true,
    section: true,
    airPaths: true,
  });
  const [selectedRoom, setSelectedRoom] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [hvacOpen, setHvacOpen] = useState(false);

  // ----- Full screen -----
  const rootRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const sync = () => setFullscreen(document.fullscreenElement !== null);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void rootRef.current?.requestFullscreen();
  };

  // ----- Walk-through -----
  const [tour, setTour] = useState<TourRequest | null>(null);
  const [pose, setPose] = useState<PlayerPose | null>(null);
  const [locked, setLocked] = useState(false);
  // Menu shown while walking is paused (after Esc); it has its own close button.
  const [tourCardOpen, setTourCardOpen] = useState(true);
  const onLockChange = (l: boolean) => {
    setLocked(l);
    if (!l) setTourCardOpen(true);
  };
  const startTour = (roomId: string) => {
    setTour((t) => ({ roomId, nonce: (t?.nonce ?? 0) + 1 }));
    setSidebarOpen(false);
    setSelectedRoom(null);
    setEditMode(false);
  };
  const exitTour = () => {
    setTour(null);
    setPose(null);
    setLocked(false);
    setTourCardOpen(true);
  };
  // Esc (while the mouse is free) opens / closes the walk-through menu. While
  // walking, the browser itself uses Esc to release the mouse.
  useEffect(() => {
    if (!tour || locked) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Escape') setTourCardOpen((o) => !o);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tour, locked]);
  const reachableDoor = tour && pose ? nearestDoor(facility, pose.x, pose.y) : null;

  // ----- CFD: whole floor and room studies -----
  const [cellSize, setCellSize] = useState(0.25);
  const cfd = useCfdRuns(facility);

  const roomFlows = useMemo(
    () =>
      Object.fromEntries(
        network.rooms.map((r) => [r.roomId, { supplyCfm: r.supplyCfm, returnCfm: r.returnCfm, exhaustCfm: r.exhaustCfm }])
      ),
    [network]
  );
  const doorFlowsCfm = useMemo(() => Object.fromEntries(network.doors.map((d) => [d.doorId, d.flowCfm])), [network]);

  const floorOptions: FacilitySimulationOptions = {
    doorMode: 'closed',
    doorsOpen: controls.doorsOpen,
    roomFlows,
    objects,
    terminalMoves,
    cellSize,
  };
  const floorKey = JSON.stringify(floorOptions);

  /** Only what affects one room goes into its key, so unrelated edits keep it current. */
  const roomOptions = (roomId: string): { options: FacilitySimulationOptions; key: string } => {
    const doorIds = facility.doors.filter((d) => d.rooms.includes(roomId)).map((d) => d.id);
    const options: FacilitySimulationOptions = {
      doorMode: 'closed',
      doorsOpen: controls.doorsOpen,
      roomFlows,
      objects,
      terminalMoves,
      roomIds: [roomId],
      doorFlowsCfm,
    };
    const key = JSON.stringify({
      roomId,
      flows: roomFlows[roomId],
      doors: doorIds.map((id) => [id, controls.doorsOpen[id], doorFlowsCfm[id]]),
      objects: objects.filter((o) => o.roomId === roomId),
      moves: Object.entries(terminalMoves).filter(([k]) => k.startsWith(`${roomId}-`)),
    });
    return { options, key };
  };

  const floorResult = cfd.floor;
  const floorStale = floorResult !== null && floorResult.key !== floorKey;
  const roomState = (roomId: string) => {
    if (cfd.active?.scope === roomId) return { state: 'running' as const, progress: cfd.active.job.progress, busy: true };
    const stored = cfd.rooms[roomId];
    const busy = cfd.active !== null;
    if (!stored) return { state: 'none' as const, busy };
    return { state: stored.key === roomOptions(roomId).key ? ('fresh' as const) : ('stale' as const), busy };
  };
  const runRoom = (roomId: string) => {
    const { options, key } = roomOptions(roomId);
    void cfd.runRoom(roomId, options, key);
  };
  const runFloor = () => void cfd.runFloor(floorOptions, floorKey);

  const combined = useMemo(
    () =>
      combineResults(
        facility,
        floorResult?.results ?? null,
        Object.values(cfd.rooms).map((r) => r.results)
      ),
    [floorResult, cfd.rooms]
  );
  const results = combined.results;

  // ----- Smoke test -----
  const [smoke, setSmoke] = useState<{ roomId: string; nonce: number; speed: number; endNow: boolean } | null>(null);
  const [smokeStats, setSmokeStats] = useState<SmokeStats | null>(null);
  const smokeRoom = smoke ? facility.rooms.find((r) => r.id === smoke.roomId) ?? null : null;
  const smokeField = smoke ? cfd.rooms[smoke.roomId]?.results.field ?? null : null;
  const smokeGeometry = useMemo(() => {
    if (!smoke) return null;
    const sources = sourcesFor(smoke.roomId, terminals);
    const room = network.rooms.find((r) => r.roomId === smoke.roomId);
    const sinks = sinksFor(facility, smoke.roomId, terminals, doorFlowsCfm, controls.doorsOpen, {
      returnCfm: room?.returnCfm ?? 0,
      exhaustCfm: room?.exhaustCfm ?? 0,
    });
    return { sources, sinks, operator: operatorSpot(facility, smoke.roomId, sources) };
  }, [smoke, terminals, network, doorFlowsCfm, controls.doorsOpen]);
  const smokeSetup =
    smoke && smokeField && smokeGeometry && smokeRoom
      ? {
          mode: 'smoke-test' as const,
          roomId: smoke.roomId,
          field: smokeField,
          ...smokeGeometry,
          roomHeight: smokeRoom.height,
          speed: smoke.speed,
          nonce: smoke.nonce,
          endNow: smoke.endNow,
        }
      : null;
  // While walking, the supply air of the room you are in is shown as moving
  // balls, once that room's airflow has been computed.
  const tourRoomId = tour && pose ? roomAt(facility, pose.x, pose.y)?.id ?? null : null;
  const tourField = tourRoomId ? cfd.rooms[tourRoomId]?.results.field ?? null : null;
  const ambientAir = useMemo(() => {
    if (!tourRoomId || !tourField) return null;
    const room = facility.rooms.find((r) => r.id === tourRoomId);
    const net = network.rooms.find((r) => r.roomId === tourRoomId);
    const sources = sourcesFor(tourRoomId, terminals);
    return {
      mode: 'air' as const,
      field: tourField,
      sources,
      sinks: sinksFor(facility, tourRoomId, terminals, doorFlowsCfm, controls.doorsOpen, {
        returnCfm: net?.returnCfm ?? 0,
        exhaustCfm: net?.exhaustCfm ?? 0,
      }),
      operator: operatorSpot(facility, tourRoomId, sources),
      roomHeight: room?.height ?? 3,
      speed: 1,
      nonce: facility.rooms.findIndex((r) => r.id === tourRoomId),
    };
  }, [tourRoomId, tourField, terminals, network, doorFlowsCfm, controls.doorsOpen]);

  // Thick supply-to-suction paths for the room being walked through, or the
  // room selected in the overview, once its airflow has been computed.
  const pathRoomId = tour ? tourRoomId : selectedRoom;
  const pathField = pathRoomId ? cfd.rooms[pathRoomId]?.results.field ?? null : null;
  const airPaths = useMemo(() => {
    if (!pathRoomId || !pathField) return null;
    const room = facility.rooms.find((r) => r.id === pathRoomId);
    const net = network.rooms.find((r) => r.roomId === pathRoomId);
    const sources = sourcesFor(pathRoomId, terminals);
    const sinks = sinksFor(facility, pathRoomId, terminals, doorFlowsCfm, controls.doorsOpen, {
      returnCfm: net?.returnCfm ?? 0,
      exhaustCfm: net?.exhaustCfm ?? 0,
    });
    const paths = traceAirPaths(pathField, sources, sinks, room?.height ?? 3);
    const { perSink, circulating } = pathShares(paths, sinks);
    return { paths, sources, sinks, shares: perSink, circulating };
  }, [pathRoomId, pathField, terminals, network, doorFlowsCfm, controls.doorsOpen]);

  /** Start (or restart) a smoke test; computes the room's airflow first when needed. */
  const startSmoke = (roomId: string) => {
    setSmokeStats(null);
    // 4× by default: clearing 95 % takes about three air changes (minutes at 1×).
    setSmoke((s) => ({ roomId, nonce: (s?.nonce ?? 0) + 1, speed: s?.speed ?? 4, endNow: false }));
    setSelectedRoom(null);
    setEditMode(false);
    const st = roomState(roomId).state;
    if (st !== 'fresh' && st !== 'running' && !cfd.active) runRoom(roomId);
  };
  const stopSmoke = () => {
    setSmoke(null);
    setSmokeStats(null);
  };

  const staleRooms = Object.keys(cfd.rooms).filter((id) => roomState(id).state === 'stale');

  // ----- Control updates -----
  const toggleDoor = (id: string) =>
    setControls((c) => ({ ...c, doorsOpen: { ...c.doorsOpen, [id]: !c.doorsOpen[id] } }));
  const setAhu = (id: string, patch: Partial<AhuControl>) =>
    setControls((c) => ({ ...c, ahu: { ...c.ahu, [id]: { ...c.ahu[id], ...patch } } }));
  const setDamper = (roomId: string, kind: 'supply' | 'return', pct: number) =>
    setControls((c) =>
      kind === 'supply'
        ? { ...c, supplyDamperPct: { ...c.supplyDamperPct, [roomId]: pct } }
        : { ...c, returnDamperPct: { ...c.returnDamperPct, [roomId]: pct } }
    );
  const closeAllDoors = () =>
    setControls((c) => ({ ...c, doorsOpen: Object.fromEntries(Object.keys(c.doorsOpen).map((k) => [k, false])) }));
  const resetToDesign = () => setControls(cloneControls(model.design));

  // ----- Alarms -----
  const roomAlarms = network.rooms.filter((r) => r.alarm === 'low' || r.alarm === 'high');
  const doorAlarms = network.doors.filter((d) => d.status === 'reversed' || d.status === 'low-dp');
  const openDoors = network.doors.filter((d) => d.open);

  // Walk-through keys: F toggles the nearest door (for real, in the pressure
  // model), 1 / 2 / 3 toggle streamlines / smoke / arrows.
  const reachableDoorId = reachableDoor?.id ?? null;
  useEffect(() => {
    if (!tour) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.code === 'KeyF' && reachableDoorId) {
        setControls((c) => ({ ...c, doorsOpen: { ...c.doorsOpen, [reachableDoorId]: !c.doorsOpen[reachableDoorId] } }));
      } else if (e.code === 'Digit1') setLayers((l) => ({ ...l, airPaths: !l.airPaths }));
      else if (e.code === 'Digit2') setLayers((l) => ({ ...l, particles: !l.particles }));
      else if (e.code === 'Digit3') setLayers((l) => ({ ...l, vectors: !l.vectors }));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tour, reachableDoorId]);

  const selected = selectedRoom ? facility.rooms.find((r) => r.id === selectedRoom) : null;
  const selectedState = selectedRoom ? network.rooms.find((r) => r.roomId === selectedRoom) : null;
  const running = cfd.active !== null;
  const runningLabel = cfd.active
    ? `${cfd.active.scope === 'floor' ? 'Floor' : facility.rooms.find((r) => r.id === cfd.active?.scope)?.shortName} CFD ${cfd.active.job.progress}%`
    : null;

  return (
    <div ref={rootRef} className="flex h-screen overflow-hidden bg-slate-950 text-slate-200">
      {/* ===== Sidebar ===== */}
      <aside className={`${sidebarOpen && !tour ? 'flex' : 'hidden'} w-95 shrink-0 flex-col border-r border-slate-800 bg-slate-900/80`}>
        <div className="border-b border-slate-800 p-4">
          <div className="flex items-center justify-between">
            <Link href="/" className="text-xs text-slate-500 hover:text-white">
              ← Dashboard
            </Link>
            <button
              onClick={() => setSidebarOpen(false)}
              title="Hide panel"
              className="rounded px-1.5 text-slate-500 hover:bg-slate-800 hover:text-white"
            >
              «
            </button>
          </div>
          <h1 className="mt-1 text-base font-bold text-white">{facility.name}</h1>
          <p className="text-[11px] text-slate-400">
            {facility.project} · {facility.rooms.length} rooms · {facility.airHandlers.filter((a) => a.kind === 'ahu').length} AHUs ·
            layout per 13 GF AHU zoning
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button onClick={closeAllDoors} className="rounded-md bg-slate-800 px-2 py-1 text-[11px] hover:bg-slate-700">
              Close all doors
            </button>
            <button onClick={resetToDesign} className="rounded-md bg-slate-800 px-2 py-1 text-[11px] hover:bg-slate-700">
              Reset to design
            </button>
          </div>
        </div>

        <nav className="flex border-b border-slate-800 text-[11px]">
          {(
            [
              ['rooms', 'Rooms'],
              ['ahus', 'AHU / VFD'],
              ['doors', `Doors${openDoors.length ? ` (${openDoors.length})` : ''}`],
              ['cfd', 'CFD'],
              ['findings', `RDS check (${model.warnings.length + ZONING_NOTES.length})`],
            ] as [Tab, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`flex-1 px-1 py-2 ${tab === id ? 'border-b-2 border-cyan-400 text-white' : 'text-slate-500 hover:text-slate-300'}`}
            >
              {label}
            </button>
          ))}
        </nav>

        <div className="flex-1 overflow-y-auto p-3">
          {tab === 'rooms' && <RoomTable facility={facility} network={network} selected={selectedRoom} onSelect={setSelectedRoom} />}

          {tab === 'ahus' && (
            <div className="space-y-3">
              {network.ahus.map((a) => (
                <AhuCard
                  key={a.id}
                  facility={facility}
                  state={a}
                  control={controls.ahu[a.id]}
                  design={model.design.ahu[a.id]}
                  onChange={(patch) => setAhu(a.id, patch)}
                />
              ))}
            </div>
          )}

          {tab === 'doors' && (
            <>
              <p className="mb-2 text-[11px] text-slate-500">
                Click a door here or in the 3D view to open it. ΔP is shown as actual / design (Pa); the flow is the air
                passing through the door gap, or through the opening when open.
              </p>
              <DoorList facility={facility} network={network} onToggle={toggleDoor} />
            </>
          )}

          {tab === 'cfd' && (
            <div className="space-y-3 text-[11px]">
              <p className="text-slate-400">
                <b className="text-slate-200">Whole floor</b> solves every room together at the chosen resolution.{' '}
                <b className="text-slate-200">Room CFD</b> (in a room&apos;s panel) solves one room on a 10 cm grid, with the air
                crossing its doors taken from the pressure model; inside that room it replaces the floor result.
              </p>
              <div className="flex items-center gap-2">
                <span className="text-slate-400">Floor grid</span>
                {[
                  [0.3, 'Quick'],
                  [0.25, 'Standard'],
                  [0.2, 'Fine'],
                ].map(([v, label]) => (
                  <button
                    key={v}
                    onClick={() => setCellSize(v as number)}
                    className={`rounded px-2 py-0.5 ${cellSize === v ? 'bg-cyan-500/20 text-cyan-200' : 'bg-slate-800 text-slate-400'}`}
                  >
                    {label} {(v as number) * 100} cm
                  </button>
                ))}
              </div>
              <button
                onClick={runFloor}
                disabled={running}
                className="w-full rounded-md bg-gradient-to-r from-cyan-500 to-blue-600 py-2 font-semibold text-white disabled:opacity-50"
              >
                {cfd.active?.scope === 'floor' ? runningLabel : floorResult && !floorStale ? 'Floor result is current' : 'Run whole-floor CFD'}
              </button>
              {cfd.active && (
                <div>
                  <div className="mb-1 flex justify-between text-slate-400">
                    <span className="truncate">{cfd.active.job.message}</span>
                    <span>{cfd.active.job.progress}%</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded bg-slate-800">
                    <div className="h-full bg-cyan-500 transition-all" style={{ width: `${cfd.active.job.progress}%` }} />
                  </div>
                </div>
              )}
              {cfd.error && <div className="rounded border border-red-500/40 bg-red-500/10 p-2 text-red-200">{cfd.error}</div>}

              <div className="grid grid-cols-2 gap-1">
                {(
                  [
                    ['airPaths', 'Air paths (selected room)'],
                    ['speedMap', 'Speed map @ 1.2 m'],
                    ['particles', 'Moving air streaks'],
                    ['streamlines', 'Air paths (lines)'],
                    ['section', 'Room section'],
                    ['vectors', 'Arrows @ 1.2 m'],
                    ['deadZones', 'Dead zones'],
                  ] as [keyof SceneLayers, string][]
                ).map(([k, label]) => (
                  <label key={k} className="flex items-center gap-2">
                    <input type="checkbox" checked={Boolean(layers[k])} onChange={() => setLayers((l) => ({ ...l, [k]: !l[k] }))} className="accent-cyan-500" />
                    {label}
                  </label>
                ))}
              </div>

              {Object.keys(cfd.rooms).length > 0 && (
                <div>
                  <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">Room studies</div>
                  {Object.entries(cfd.rooms).map(([id, r]) => {
                    const st = roomState(id);
                    return (
                      <div key={id} className="flex items-center justify-between border-t border-slate-800 py-1">
                        <span>
                          {facility.rooms.find((x) => x.id === id)?.shortName}{' '}
                          <span className="text-slate-500">
                            {r.results.grid.hx * 100} cm · {r.results.solver.seconds}s
                          </span>
                        </span>
                        <span className="flex gap-1">
                          {st.state === 'stale' && (
                            <button onClick={() => runRoom(id)} disabled={running} className="rounded bg-amber-500/20 px-1.5 text-amber-200">
                              ↻ re-run
                            </button>
                          )}
                          <button onClick={() => cfd.clearRoom(id)} className="rounded bg-slate-800 px-1.5 text-slate-400">
                            ✕
                          </button>
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}

              {results && (
                <>
                  {results.warnings.map((w, i) => (
                    <div key={i} className="text-slate-500">
                      {w}
                    </div>
                  ))}
                  <table className="w-full">
                    <thead className="text-slate-500">
                      <tr>
                        <th className="text-left font-medium">Room</th>
                        <th className="text-right font-medium">ACPH</th>
                        <th className="text-right font-medium">1.2 m zone</th>
                        <th className="text-right font-medium">Stagnant</th>
                      </tr>
                    </thead>
                    <tbody>
                      {results.rooms.map((r) => {
                        const room = facility.rooms.find((x) => x.id === r.roomId);
                        return (
                          <tr key={r.roomId} className="border-t border-slate-800">
                            <td className="py-0.5 text-slate-300">
                              {room?.shortName}
                              {combined.detailed.has(r.roomId) && <span className="ml-1 text-[9px] text-cyan-400">fine</span>}
                            </td>
                            <td className="text-right font-mono">{r.achievedAcph}</td>
                            <td className="text-right font-mono">{r.workingZoneSpeed.toFixed(2)}</td>
                            <td className={`text-right font-mono ${r.stagnantFraction > 0.35 ? 'text-amber-300' : ''}`}>
                              {(r.stagnantFraction * 100).toFixed(0)}%
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          )}

          {tab === 'findings' && (
            <div className="space-y-2 text-[11px]">
              <p className="text-slate-400">Drawing vs RDS:</p>
              {ZONING_NOTES.map((w, i) => (
                <div key={`z${i}`} className="rounded-md border border-sky-500/30 bg-sky-500/5 p-2 text-sky-100/90">
                  {w}
                </div>
              ))}
              <p className="pt-1 text-slate-400">
                Commissioning the network to the RDS (all doors shut, VFDs at 45 Hz) balances every room to its design
                pressure. These are the places where the RDS figures and the room leakage do not agree:
              </p>
              {model.warnings.map((w, i) => (
                <div key={i} className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-amber-100/90">
                  {w}
                </div>
              ))}
              <p className="pt-2 text-slate-500">
                Door leakage assumes a 2 mm perimeter gap on a shut door (≈0.01 m² per single leaf). HEPA filters are
                modelled at 200 Pa clean at rated flow, rising to 500 Pa at change-out.
              </p>
            </div>
          )}
        </div>
      </aside>

      {/* ===== 3D view ===== */}
      <main className="relative flex-1">
        <div className="absolute inset-0">
          <FacilityScene3D
            facility={facility}
            walls={walls}
            contextWalls={contextWalls}
            terminals={terminals}
            objects={objects}
            network={network}
            colorMode={colorMode}
            layers={layers}
            results={results}
            slices={combined.slices}
            sections={combined.sections}
            selectedRoom={selectedRoom}
            onSelectRoom={setSelectedRoom}
            onToggleDoor={toggleDoor}
            tour={tour}
            onPlayer={setPose}
            onLockChange={onLockChange}
            editMode={editMode}
            selectedObject={selectedObject}
            onSelectObject={setSelectedObject}
            onMoveObject={moveObject}
            onMoveTerminal={moveTerminal}
            smoke={smokeSetup}
            onSmokeStats={setSmokeStats}
            ambientAir={ambientAir}
            airPaths={airPaths}
            selectedTerminal={selectedTerminal}
            onSelectTerminal={(id) => {
              setSelectedTerminal(id);
              if (id) setSelectedObject(null);
            }}
          />
        </div>

        {tour && (
          <TourHud
            facility={facility}
            network={network}
            results={results}
            cfdRunning={running}
            pose={pose}
            locked={locked}
            air={pose ? airAt(facility, results, pose.x, pose.y) : null}
            door={reachableDoor}
            layers={layers}
            onLayers={setLayers}
            onTeleport={startTour}
            onRunCfd={runFloor}
            onExit={exitTour}
            cardOpen={tourCardOpen}
            onCardClose={() => setTourCardOpen(false)}
            onSmokeTest={startSmoke}
            smokeRunning={smoke !== null}
            onRoomCfd={runRoom}
            roomCfdState={tourRoomId ? roomState(tourRoomId).state : 'none'}
            roomAirShown={ambientAir !== null}
            airDestinations={
              airPaths
                ? [
                    ...airPaths.sinks
                      .map((s, i) => ({ id: s.id, label: s.label, color: sinkColor(i), share: airPaths.shares[i] }))
                      .filter((d) => d.share > 0.005),
                    ...(airPaths.circulating > 0.005
                      ? [{ id: 'circulating', label: 'Still circulating', color: sinkColor(-1), share: airPaths.circulating }]
                      : []),
                  ]
                : []
            }
          />
        )}

        {/* Top bar */}
        <div className={`pointer-events-none absolute left-3 right-3 top-3 flex-wrap items-start gap-2 ${tour ? 'hidden' : 'flex'}`}>
          {!sidebarOpen && (
            <button
              onClick={() => setSidebarOpen(true)}
              title="Show panel"
              className="pointer-events-auto rounded-lg border border-slate-700 bg-slate-900/90 px-2.5 py-1 text-[11px] text-slate-300 hover:text-white"
            >
              ☰ Panel
            </button>
          )}
          <div className="pointer-events-auto flex rounded-lg border border-slate-700 bg-slate-900/90 p-0.5 text-[11px]">
            {(
              [
                ['pressure', 'Live pressure'],
                ['deviation', 'vs design'],
                ['ahu', 'AHU zoning'],
                ['class', 'Area class'],
              ] as [ColorMode, string][]
            ).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setColorMode(id)}
                className={`rounded-md px-2 py-1 ${colorMode === id ? 'bg-cyan-500/20 text-cyan-200' : 'text-slate-400 hover:text-white'}`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="pointer-events-auto flex gap-1 rounded-lg border border-slate-700 bg-slate-900/90 p-1 text-[11px]">
            <Toggle on={layers.walls === 'cut'} label="Cut walls" onClick={() => setLayers((l) => ({ ...l, walls: l.walls === 'cut' ? 'full' : 'cut' }))} />
            <Toggle on={layers.labels} label="Labels" onClick={() => setLayers((l) => ({ ...l, labels: !l.labels }))} />
            <Toggle on={layers.doorDp} label="Door ΔP" onClick={() => setLayers((l) => ({ ...l, doorDp: !l.doorDp }))} />
            <Toggle on={layers.terminals} label="Terminals" onClick={() => setLayers((l) => ({ ...l, terminals: !l.terminals }))} />
          </div>
          <div className="pointer-events-auto flex gap-1 rounded-lg border border-slate-700 bg-slate-900/90 p-1 text-[11px]">
            <button onClick={() => setHvacOpen(true)} className="rounded-md bg-emerald-500/15 px-2 py-0.5 font-semibold text-emerald-200 hover:bg-emerald-500/25">
              ✓ HVAC check
            </button>
            <button
              onClick={() => {
                setEditMode((e) => !e);
                setSelectedObject(null);
              }}
              className={`rounded-md px-2 py-0.5 font-semibold ${editMode ? 'bg-amber-500/25 text-amber-200' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
            >
              ✎ Edit layout
            </button>
            <button
              onClick={runFloor}
              disabled={running}
              className="rounded-md bg-cyan-500/20 px-2 py-0.5 font-semibold text-cyan-200 hover:bg-cyan-500/30 disabled:opacity-60"
            >
              {runningLabel ?? (floorResult ? (floorStale ? '↻ Re-run floor CFD' : 'Floor CFD ✓') : '▶ Floor CFD')}
            </button>
            <button
              onClick={() => startTour(selectedRoom ?? 'mfg')}
              className="rounded-md bg-slate-800 px-2 py-0.5 font-semibold text-slate-200 hover:bg-slate-700"
            >
              🚶 Walk-through
            </button>
            <button
              onClick={() => (smoke ? stopSmoke() : startSmoke(selectedRoom ?? 'filling'))}
              title={selectedRoom ? 'Smoke test in the selected room' : 'Smoke test (select a room to choose which)'}
              className={`rounded-md px-2 py-0.5 font-semibold ${smoke ? 'bg-slate-200 text-slate-900' : 'bg-slate-800 text-slate-200 hover:bg-slate-700'}`}
            >
              {smoke ? '■ Stop smoke test' : '💨 Run smoke test'}
            </button>
            <Toggle on={fullscreen} label={fullscreen ? 'Exit full screen' : '⛶ Full screen'} onClick={toggleFullscreen} />
          </div>
          <div className="pointer-events-auto ml-auto flex gap-2 text-[11px]">
            <Chip tone={roomAlarms.length ? 'red' : 'green'}>
              {roomAlarms.length ? `${roomAlarms.length} room${roomAlarms.length > 1 ? 's' : ''} off pressure` : 'All rooms at pressure'}
            </Chip>
            {doorAlarms.length > 0 && <Chip tone="amber">{doorAlarms.length} door ΔP alarm{doorAlarms.length > 1 ? 's' : ''}</Chip>}
            {(floorStale || staleRooms.length > 0) && <Chip tone="amber">CFD out of date — re-run</Chip>}
          </div>
        </div>

        {!tour && !smoke && (
          <div className="pointer-events-none absolute bottom-3 left-3 flex items-end gap-2">
            <Legend mode={colorMode} />
            {results && <AirflowLegend />}
          </div>
        )}

        {smoke && smokeRoom && (
          <div className="absolute right-3 top-14 z-10 max-h-[calc(100%-5rem)] overflow-y-auto">
            <SmokePanel
              roomName={smokeRoom.name}
              stats={smokeStats}
              preparing={
                smokeField
                  ? null
                  : cfd.active?.scope === smoke.roomId
                    ? { progress: cfd.active.job.progress, message: cfd.active.job.message }
                    : { progress: 0, message: cfd.active ? 'Waiting for the current CFD run to finish…' : 'Starting…' }
              }
              staleAirflow={roomState(smoke.roomId).state === 'stale'}
              sinks={smokeGeometry?.sinks ?? []}
              speed={smoke.speed}
              onSpeed={(v) => setSmoke((s) => (s ? { ...s, speed: v } : s))}
              onRestart={() => startSmoke(smoke.roomId)}
              onStop={stopSmoke}
              onEndNow={() => setSmoke((s) => (s ? { ...s, endNow: true } : s))}
            />
          </div>
        )}

        {!tour && !smoke && (editMode || (selected && selectedState)) && (
          <div className="absolute right-3 top-14 flex max-h-[calc(100%-5rem)] flex-col gap-2 overflow-y-auto">
            {editMode && (
              <LayoutEditor
                facility={facility}
                roomId={selectedRoom}
                objects={objects}
                selected={selectedObject}
                movedTerminals={Object.keys(terminalMoves).length}
                onSelect={setSelectedObject}
                onChange={setObjects}
                onResetObjects={() => setObjects(facility.objects)}
                onResetTerminals={() => setTerminalMoves({})}
                onClose={() => {
                  setEditMode(false);
                  setSelectedTerminal(null);
                }}
                terminals={terminals}
                selectedTerminal={selectedTerminal}
                movedTerminalIds={Object.keys(terminalMoves)}
                onSelectTerminal={setSelectedTerminal}
                onMoveTerminal={moveTerminal}
                onResetTerminal={(id) =>
                  setTerminalMoves((m) => {
                    const next = { ...m };
                    delete next[id];
                    return next;
                  })
                }
              />
            )}
            {selected && selectedState && (
              <RoomDetail
                facility={facility}
                room={selected}
                state={selectedState}
                network={network}
                controls={controls}
                design={model.design}
                cfd={results}
                onDamper={(kind, pct) => setDamper(selected.id, kind, pct)}
                onTour={() => startTour(selected.id)}
                roomCfd={roomState(selected.id)}
                onRunRoomCfd={() => runRoom(selected.id)}
                onSmokeTest={() => startSmoke(selected.id)}
                onEditTerminals={() => {
                  setEditMode(true);
                  setSelectedObject(null);
                }}
                onClose={() => setSelectedRoom(null)}
              />
            )}
          </div>
        )}

        {hvacOpen && <HvacCheck facility={facility} network={network} onClose={() => setHvacOpen(false)} />}
      </main>
    </div>
  );
}

const round2 = (v: number) => Math.round(v * 100) / 100;

function Toggle({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`rounded-md px-2 py-0.5 ${on ? 'bg-slate-700 text-white' : 'text-slate-500 hover:text-slate-300'}`}>
      {label}
    </button>
  );
}

function Chip({ tone, children }: { tone: 'red' | 'green' | 'amber'; children: React.ReactNode }) {
  const cls =
    tone === 'red'
      ? 'border-red-500/50 bg-red-500/15 text-red-200'
      : tone === 'amber'
        ? 'border-amber-500/50 bg-amber-500/15 text-amber-200'
        : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200';
  return <span className={`rounded-full border px-2.5 py-1 ${cls}`}>{children}</span>;
}

function Legend({ mode }: { mode: ColorMode }) {
  let items: [string, string][] = [];
  if (mode === 'ahu') items = Object.entries(AHU_COLORS).map(([k, c]) => [k, c]);
  if (mode === 'class') items = [['Grade D', CLASS_COLORS.D], ['CNC', CLASS_COLORS.CNC], ['NC (exhaust)', CLASS_COLORS.NC]];
  if (mode === 'deviation') items = [['Within ½ band', '#16a34a'], ['Within band', '#eab308'], ['Outside ±max(5 Pa, 25%)', '#dc2626']];
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/90 p-2 text-[11px]">
      {mode === 'pressure' ? (
        <div>
          <div className="mb-1 text-slate-400">Floor colour: room pressure (Pa vs outdoors)</div>
          <div className="h-2 w-48 rounded" style={{ background: `linear-gradient(to right, ${[0, 10, 20, 30, 40].map(pressureColor).join(',')})` }} />
          <div className="flex w-48 justify-between text-slate-500">
            <span>0</span>
            <span>20</span>
            <span>40</span>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
          {items.map(([label, color]) => (
            <div key={label} className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: color }} />
              <span className="text-slate-300">{label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Speed scale shared by every airflow visual, and how to read them. */
function AirflowLegend() {
  const [open, setOpen] = useState(false);
  return (
    <div className="pointer-events-auto w-80 rounded-lg border border-slate-700 bg-slate-900/90 p-2 text-[11px]">
      <div className="mb-1 flex items-center justify-between text-slate-400">
        <span>Air speed (m/s) — same colours on every airflow layer</span>
        <button onClick={() => setOpen((o) => !o)} className="rounded bg-slate-800 px-1.5 text-slate-300">
          {open ? 'less' : 'how to read'}
        </button>
      </div>
      <div className="h-2.5 rounded" style={{ background: speedGradientCss() }} />
      <div className="flex justify-between text-slate-500">
        <span>0 still</span>
        <span>0.15</span>
        <span>0.3</span>
        <span>0.45 HEPA</span>
        <span>{SPEED_SCALE_MAX}+ jet</span>
      </div>
      {open && (
        <div className="mt-2 space-y-1.5 leading-relaxed text-slate-300">
          <p>
            <b>Moving streaks</b> are parcels of air. Each streak points the way the air is going and is as long as the
            distance it covers in 0.7 s — long and red is fast, short and blue is slow. They move at the real speed in a
            walk-through and 4× faster in this overview.
          </p>
          <p>
            <b>Speed map</b> is the air speed on a horizontal cut at 1.2 m (working height). Dark blue is below 0.05 m/s:
            still air that does not get flushed — a dead zone.
          </p>
          <p>
            <b>Lines</b> are the paths air takes from each HEPA / diffuser until it leaves through a riser or a door gap.
            A <b>room section</b> (after a room CFD) is a vertical cut down the room with arrows: HEPA air falls, spreads
            across the floor and is drawn into the low-level risers.
          </p>
          <p className="text-slate-500">
            Physics: incompressible, isothermal airflow (Navier–Stokes with the Chen–Xu indoor turbulence model), time-averaged.
            HEPAs discharge straight down at their face velocity; 4-way diffusers throw sideways 30° below the ceiling; risers
            extract at 150–450 mm; doors carry the leakage from the pressure model. Supply and extract per room are the
            pressure-network values, so the flow is mass-balanced. Not modelled: heat plumes from people and machines.
          </p>
        </div>
      )}
    </div>
  );
}
