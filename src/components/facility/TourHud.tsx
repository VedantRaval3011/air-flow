'use client';

import { Facility, FacilityDoor, FacilityResults } from '@/lib/facility/types';
import { NetworkState } from '@/lib/facility/network';
import { roomAt } from '@/lib/facility/geometry';
import { LocalAir } from '@/lib/facility/tour';
import { TOUR_LOCK_EVENT, type PlayerPose, type SceneLayers } from './FacilityScene3D';
import { roomName } from './panels';

interface Props {
  facility: Facility;
  network: NetworkState;
  results: FacilityResults | null;
  cfdRunning: boolean;
  pose: PlayerPose | null;
  locked: boolean;
  air: LocalAir | null;
  door: FacilityDoor | null;
  layers: SceneLayers;
  onLayers: (fn: (l: SceneLayers) => SceneLayers) => void;
  onTeleport: (roomId: string) => void;
  onRunCfd: () => void;
  onExit: () => void;
  /** The paused menu (shown after Esc) */
  cardOpen: boolean;
  onCardClose: () => void;
  onSmokeTest: (roomId: string) => void;
  smokeRunning: boolean;
  /** Room CFD for the room being walked through */
  onRoomCfd: (roomId: string) => void;
  roomCfdState: 'none' | 'running' | 'fresh' | 'stale';
  /** The room's supply air is being shown as moving balls */
  roomAirShown: boolean;
  /** Where the room's air leaves, matching the air-path colours */
  airDestinations: { id: string; label: string; color: string; share: number }[];
}

/** How the air at the walker's position would feel / what it means in a cleanroom. */
function describeAir(speed: number): { label: string; tone: string } {
  if (speed < 0.05) return { label: 'Still air — possible dead zone', tone: 'text-red-300' };
  if (speed < 0.15) return { label: 'Gentle mixing', tone: 'text-emerald-300' };
  if (speed < 0.35) return { label: 'Steady air movement', tone: 'text-cyan-300' };
  return { label: 'Strong draught (near a terminal or door)', tone: 'text-amber-300' };
}

/** Capture the mouse for walking (handled by the walk-through controller). */
const requestWalk = () => window.dispatchEvent(new Event(TOUR_LOCK_EVENT));

export default function TourHud(props: Props) {
  const { facility, network, results, pose, locked, air, door } = props;
  const room = pose ? roomAt(facility, pose.x, pose.y) : null;
  const state = room ? network.rooms.find((r) => r.roomId === room.id) : null;
  const cfdRoom = room && results ? results.rooms.find((r) => r.roomId === room.id) : null;

  const doors = room
    ? network.doors.filter((d) => {
        const fd = facility.doors.find((x) => x.id === d.doorId);
        return fd && (fd.rooms[0] === room.id || fd.rooms[1] === room.id);
      })
    : [];

  // Arrow for the air relative to where the walker is looking (up = straight ahead).
  let arrowDeg = 0;
  let horizontal = 0;
  if (air && pose) {
    const ahead = air.dir[0] * pose.fx + air.dir[1] * pose.fy;
    const right = air.dir[0] * -pose.fy + air.dir[1] * pose.fx;
    arrowDeg = (Math.atan2(right, ahead) * 180) / Math.PI;
    horizontal = Math.hypot(air.dir[0], air.dir[1]);
  }
  const doorState = door ? network.doors.find((d) => d.doorId === door.id) : null;

  return (
    <div className="pointer-events-none absolute inset-0 select-none text-[12px] text-slate-200">
      {/* Crosshair */}
      {locked && (
        <div className="absolute left-1/2 top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/70" />
      )}

      {/* Current room */}
      <div className="absolute left-3 top-3 w-72 rounded-xl border border-slate-700/70 bg-slate-950/80 p-3 backdrop-blur">
        {room && state ? (
          <>
            <div className="text-[10px] uppercase tracking-wider text-slate-500">You are in</div>
            <div className="text-base font-semibold text-white">{room.name}</div>
            <div className="text-[11px] text-slate-400">
              {room.hvac.ahu} · Grade {room.hvac.areaClass} · {room.hvac.terminalType === 'HEPA' ? 'HEPA supply' : room.hvac.terminalType === 'DIFFUSER' ? 'Diffuser supply' : 'Exhaust only'}
            </div>
            <div className="mt-2 flex items-end gap-3">
              <div>
                <div className="text-[10px] text-slate-500">Room pressure</div>
                <div className={`font-mono text-2xl ${state.alarm === 'low' || state.alarm === 'high' ? 'text-red-300' : 'text-emerald-300'}`}>
                  {state.pressurePa >= 0 ? '+' : ''}
                  {state.pressurePa.toFixed(1)}
                  <span className="text-sm text-slate-500"> Pa</span>
                </div>
              </div>
              <div className="pb-1 text-[11px] text-slate-400">
                design {state.designPa ?? '—'} Pa
                <br />
                {state.achievedAcph} ACPH · {state.supplyCfm} CFM in
              </div>
            </div>
            {doors.length > 0 && (
              <div className="mt-2 space-y-0.5 border-t border-slate-800 pt-2">
                {doors.map((d) => {
                  const fd = facility.doors.find((x) => x.id === d.doorId)!;
                  const mine = fd.rooms[0] === room.id;
                  const other = mine ? fd.rooms[1] : fd.rooms[0];
                  const dp = mine ? d.dpPa : -d.dpPa;
                  const outflow = mine ? d.flowCfm : -d.flowCfm;
                  const tone = d.status === 'reversed' ? 'text-red-300' : d.status === 'low-dp' ? 'text-amber-300' : d.open ? 'text-sky-300' : 'text-slate-300';
                  return (
                    <div key={d.doorId} className={`flex justify-between gap-2 text-[11px] ${tone}`}>
                      <span className="truncate">
                        {d.open ? '▯ ' : '▮ '}
                        {roomName(facility, other)}
                      </span>
                      <span className="shrink-0 font-mono">
                        {dp >= 0 ? '+' : ''}
                        {dp.toFixed(1)} Pa · {Math.abs(outflow)} CFM {outflow >= 0 ? 'out' : 'in'}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        ) : (
          <div className="text-slate-400">Moving between rooms…</div>
        )}
      </div>

      {/* Air here */}
      <div className="absolute bottom-3 right-3 w-64 rounded-xl border border-slate-700/70 bg-slate-950/80 p-3 backdrop-blur">
        <div className="text-[10px] uppercase tracking-wider text-slate-500">Air where you stand (1.2 m)</div>
        {room && !props.roomAirShown && (
          <div className="pointer-events-auto mt-1">
            <p className="text-slate-400">
              Compute this room&apos;s airflow to see the air moving as balls: in at the top, out at the suction.
            </p>
            <button
              onClick={() => props.onRoomCfd(room.id)}
              disabled={props.roomCfdState === 'running' || props.cfdRunning}
              className="mt-2 w-full rounded-md bg-cyan-600 py-1.5 font-semibold text-white disabled:opacity-60"
            >
              {props.roomCfdState === 'running' ? 'Computing airflow…' : props.cfdRunning ? 'Another CFD run is busy…' : 'Show the air in this room'}
            </button>
          </div>
        )}
        {air ? (
          <div className="mt-1 flex items-center gap-3">
            <div className="relative h-16 w-16 shrink-0 rounded-full border border-slate-700 bg-slate-900">
              <div className="absolute left-1/2 top-1 -translate-x-1/2 text-[9px] text-slate-600">ahead</div>
              <svg viewBox="-20 -20 40 40" className="absolute inset-0 h-full w-full" style={{ transform: `rotate(${arrowDeg}deg)` }}>
                <line x1="0" y1="11" x2="0" y2={-11 * Math.max(0.25, horizontal)} stroke="#22d3ee" strokeWidth="2.5" strokeLinecap="round" />
                <polygon points={`0,${-15 * Math.max(0.25, horizontal)} -4,${-8 * Math.max(0.25, horizontal)} 4,${-8 * Math.max(0.25, horizontal)}`} fill="#22d3ee" />
              </svg>
            </div>
            <div>
              <div className="font-mono text-xl text-white">
                {air.speed.toFixed(2)}
                <span className="text-sm text-slate-500"> m/s</span>
              </div>
              <div className={describeAir(air.speed).tone}>{describeAir(air.speed).label}</div>
              <div className="text-[11px] text-slate-400">
                {air.dir[2] < -0.3 ? '↓ falling from the ceiling' : air.dir[2] > 0.3 ? '↑ rising' : '→ moving across the room'}
              </div>
            </div>
          </div>
        ) : results && props.roomAirShown ? (
          <div className="mt-1 text-slate-400">No sample here (inside a wall or doorway).</div>
        ) : null}
        {props.airDestinations.length > 0 && (
          <div className="mt-2 border-t border-slate-800 pt-2">
            <div className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">Where this room&apos;s air leaves</div>
            {props.airDestinations.map((d) => (
              <div key={d.id} className="flex items-center gap-2 text-[11px]">
                <span className="h-2 w-4 rounded-sm" style={{ background: d.color }} />
                <span className="flex-1 truncate text-slate-300">{d.label}</span>
                <span className="font-mono text-slate-400">{Math.round(d.share * 100)}%</span>
              </div>
            ))}
            <div className="mt-1 text-[10px] text-slate-500">Each tube is a path of air; the arrows move at its real speed.</div>
          </div>
        )}
        {cfdRoom && (
          <div className="mt-2 grid grid-cols-2 gap-1 border-t border-slate-800 pt-2 text-[11px]">
            <span className="text-slate-500">Room mean (0.5–1.8 m)</span>
            <span className="text-right font-mono">{cfdRoom.workingZoneSpeed.toFixed(2)} m/s</span>
            <span className="text-slate-500">Stagnant volume</span>
            <span className={`text-right font-mono ${cfdRoom.stagnantFraction > 0.35 ? 'text-amber-300' : ''}`}>
              {(cfdRoom.stagnantFraction * 100).toFixed(0)}%
            </span>
          </div>
        )}
      </div>

      <Minimap facility={facility} network={network} pose={pose} currentRoom={room?.id ?? null} />

      {/* Door action hint */}
      {locked && door && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 rounded-lg border border-slate-600 bg-slate-950/85 px-3 py-1.5">
          <span className="mr-2 rounded bg-slate-700 px-1.5 font-mono text-white">F</span>
          {doorState?.open ? 'Close' : 'Open'} door {roomName(facility, door.rooms[0])} ↔ {roomName(facility, door.rooms[1])}
          {doorState && <span className="ml-2 font-mono text-slate-400">ΔP {Math.abs(doorState.dpPa).toFixed(1)} Pa</span>}
        </div>
      )}

      {/* Menu closed while paused: a small way back in */}
      {!locked && !props.cardOpen && (
        <div className="pointer-events-auto absolute bottom-6 left-1/2 flex -translate-x-1/2 gap-2">
          <button onClick={requestWalk} className="rounded-lg bg-cyan-600 px-4 py-2 font-semibold text-white shadow-lg hover:bg-cyan-500">
            Click to walk
          </button>
          <span className="self-center rounded bg-slate-900/80 px-2 py-1 text-[11px] text-slate-400">Esc for menu</span>
        </div>
      )}

      {/* Paused / start card */}
      {!locked && props.cardOpen && (
        <div className="pointer-events-auto absolute left-1/2 top-1/2 w-[380px] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-slate-700 bg-slate-950/90 p-5 text-center shadow-2xl backdrop-blur">
          <button
            onClick={props.onCardClose}
            aria-label="Close"
            title="Close (Esc)"
            className="absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded-full bg-slate-800 text-base leading-none text-slate-200 hover:bg-slate-700 hover:text-white"
          >
            ×
          </button>
          <div className="text-[10px] uppercase tracking-wider text-cyan-400">Walk-through</div>
          <div className="mb-3 text-lg font-semibold text-white">{room?.name ?? 'Facility'}</div>
          <button onClick={requestWalk} className="w-full rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 py-2.5 font-semibold text-white">
            Click to walk
          </button>
          {room && (
            <button
              onClick={() => props.onSmokeTest(room.id)}
              className="mt-2 w-full rounded-lg bg-slate-800 py-2 font-semibold text-slate-100 hover:bg-slate-700"
            >
              {props.smokeRunning ? 'Restart smoke test here' : '💨 Run smoke test in this room'}
            </button>
          )}
          <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-left text-[11px] text-slate-400">
            <span><Key>W A S D</Key> / arrows move</span>
            <span><Key>Mouse</Key> look around</span>
            <span><Key>Shift</Key> walk faster</span>
            <span><Key>F</Key> open / close door</span>
            <span><Key>1</Key><Key>2</Key><Key>3</Key> air paths · balls · arrows</span>
            <span><Key>Esc</Key> menu / close menu</span>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <select
              value={room?.id ?? ''}
              onChange={(e) => props.onTeleport(e.target.value)}
              className="flex-1 rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-[12px]"
            >
              {facility.rooms.map((r) => (
                <option key={r.id} value={r.id}>
                  Go to: {r.name}
                </option>
              ))}
            </select>
            <button onClick={props.onExit} className="rounded-md bg-slate-800 px-3 py-1.5 hover:bg-slate-700">
              Exit tour
            </button>
          </div>
          <div className="mt-2 flex justify-center gap-3 text-[11px]">
            {(
              [
                ['airPaths', 'Air paths'],
                ['particles', 'Balls'],
                ['vectors', 'Arrows @ 1.2 m'],
              ] as [keyof SceneLayers, string][]
            ).map(([k, label]) => (
              <label key={k} className="flex items-center gap-1">
                <input type="checkbox" checked={Boolean(props.layers[k])} onChange={() => props.onLayers((l) => ({ ...l, [k]: !l[k] }))} className="accent-cyan-500" />
                {label}
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Key({ children }: { children: React.ReactNode }) {
  return <span className="mr-1 rounded bg-slate-800 px-1 font-mono text-[10px] text-slate-200">{children}</span>;
}

function Minimap({
  facility,
  network,
  pose,
  currentRoom,
}: {
  facility: Facility;
  network: NetworkState;
  pose: PlayerPose | null;
  currentRoom: string | null;
}) {
  const w = facility.extent.width;
  const d = facility.extent.depth;
  const open = new Set(network.doors.filter((x) => x.open).map((x) => x.doorId));
  return (
    <div className="absolute bottom-3 left-3 rounded-xl border border-slate-700/70 bg-slate-950/80 p-2 backdrop-blur">
      <svg viewBox={`-0.5 -0.5 ${w + 1} ${d + 1}`} className="h-56" style={{ width: `${(14 * (w + 1)) / (d + 1)}rem` }}>
        {facility.rooms.flatMap((room) =>
          room.rects.map((r, i) => (
            <rect
              key={`${room.id}-${i}`}
              x={r.x0}
              y={r.y0}
              width={r.x1 - r.x0}
              height={r.y1 - r.y0}
              fill={room.id === currentRoom ? '#0e7490' : '#1e293b'}
              stroke="#475569"
              strokeWidth={0.08}
            />
          ))
        )}
        {facility.doors
          .filter((door) => open.has(door.id))
          .map((door) => (
            <circle key={door.id} cx={door.x} cy={door.y} r={0.35} fill="#38bdf8" />
          ))}
        {pose && (
          <g>
            <line x1={pose.x} y1={pose.y} x2={pose.x + pose.fx * 1.6} y2={pose.y + pose.fy * 1.6} stroke="#facc15" strokeWidth={0.18} />
            <circle cx={pose.x} cy={pose.y} r={0.4} fill="#facc15" />
          </g>
        )}
      </svg>
    </div>
  );
}
