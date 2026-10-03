'use client';

import { ReactNode } from 'react';
import { Facility, FacilityResults, FacilityRoom } from '@/lib/facility/types';
import { AhuControl, AhuState, DoorState, HvacControls, NetworkState, RoomState } from '@/lib/facility/network';
import { ahuColor } from '@/lib/facility/geometry';

// ============= Small building blocks =============

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  unit = '%',
  design,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  design?: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <div className="flex items-baseline justify-between text-[11px]">
        <span className="text-slate-400">{label}</span>
        <span className="font-mono text-slate-100">
          {value.toFixed(step < 1 ? 1 : 0)}
          {unit}
          {design !== undefined && Math.abs(design - value) > 0.05 && (
            <span className="ml-1 text-slate-500">(design {design.toFixed(step < 1 ? 1 : 0)})</span>
          )}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 w-full accent-cyan-500"
      />
    </label>
  );
}

function Stat({ label, value, unit, tone }: { label: string; value: ReactNode; unit?: string; tone?: string }) {
  return (
    <div className="rounded-md bg-slate-800/60 px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`font-mono text-[13px] ${tone ?? 'text-slate-100'}`}>
        {value}
        {unit && <span className="ml-0.5 text-[10px] text-slate-500">{unit}</span>}
      </div>
    </div>
  );
}

const alarmTone = (a: RoomState['alarm']) =>
  a === 'ok' ? 'text-emerald-300' : a === 'low' || a === 'high' ? 'text-red-300' : 'text-slate-300';

const doorTone = (s: DoorState['status']) =>
  s === 'open' ? 'text-sky-300' : s === 'reversed' ? 'text-red-300' : s === 'low-dp' ? 'text-amber-300' : s === 'ok' ? 'text-emerald-300' : 'text-slate-400';

const doorLabel = (s: DoorState['status']) =>
  s === 'open' ? 'OPEN' : s === 'reversed' ? 'REVERSED' : s === 'low-dp' ? 'LOW ΔP' : s === 'ok' ? 'OK' : '—';

export function roomName(facility: Facility, id: string | null) {
  if (!id) return 'Outside';
  return facility.rooms.find((r) => r.id === id)?.shortName ?? id;
}

// ============= Rooms =============

export function RoomTable({
  facility,
  network,
  selected,
  onSelect,
}: {
  facility: Facility;
  network: NetworkState;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <table className="w-full text-[11px]">
      <thead className="sticky top-0 bg-slate-900 text-slate-500">
        <tr>
          <th className="py-1 text-left font-medium">Room</th>
          <th className="text-right font-medium">Pa</th>
          <th className="text-right font-medium">Design</th>
          <th className="text-right font-medium">CFM</th>
          <th className="text-right font-medium">ACPH</th>
        </tr>
      </thead>
      <tbody>
        {network.rooms.map((r) => {
          const room = facility.rooms.find((x) => x.id === r.roomId) as FacilityRoom;
          return (
            <tr
              key={r.roomId}
              onClick={() => onSelect(r.roomId)}
              className={`cursor-pointer border-t border-slate-800 hover:bg-slate-800/60 ${selected === r.roomId ? 'bg-cyan-500/10' : ''}`}
            >
              <td className="py-1">
                <span className="mr-1.5 inline-block h-2 w-2 rounded-sm" style={{ background: ahuColor(room.hvac.ahu) }} />
                <span className="text-slate-200">{room.shortName}</span>
                <span className="ml-1 text-slate-500">{room.hvac.areaClass}</span>
              </td>
              <td className={`text-right font-mono ${alarmTone(r.alarm)}`}>{r.pressurePa.toFixed(1)}</td>
              <td className="text-right font-mono text-slate-500">{r.designPa ?? '—'}</td>
              <td className="text-right font-mono text-slate-300">{r.supplyCfm || r.exhaustCfm}</td>
              <td className="text-right font-mono text-slate-300">{r.achievedAcph || '—'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ============= AHUs =============

export function AhuCard({
  facility,
  state,
  control,
  design,
  onChange,
}: {
  facility: Facility;
  state: AhuState;
  control: AhuControl;
  design: AhuControl;
  onChange: (patch: Partial<AhuControl>) => void;
}) {
  const handler = facility.airHandlers.find((h) => h.id === state.id);
  const served = facility.rooms.filter((r) => r.hvac.ahu === state.id);
  const supplyPct = state.designSupplyCfm > 0 ? (100 * state.supplyCfm) / state.designSupplyCfm : 0;
  const isAhu = state.kind === 'ahu';

  return (
    <div className="rounded-lg border border-slate-700/60 bg-slate-900/60 p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-sm" style={{ background: ahuColor(state.id) }} />
          <span className="font-semibold text-white">{state.id}</span>
          <span className="text-[10px] text-slate-500">{isAhu ? `${handler?.ratedCfm} CFM · ${handler?.filtration}` : 'Exhaust fan'}</span>
        </div>
        <button
          onClick={() => onChange({ running: !control.running })}
          className={`rounded px-2 py-0.5 text-[10px] font-semibold ${control.running ? 'bg-emerald-500/20 text-emerald-300' : 'bg-red-500/20 text-red-300'}`}
        >
          {control.running ? 'RUNNING' : 'STOPPED'}
        </button>
      </div>

      <div className="mb-2 grid grid-cols-3 gap-1.5">
        <Stat label="VFD" value={state.hz.toFixed(1)} unit="Hz" />
        <Stat label="Motor" value={state.motorRpm} unit="rpm" />
        <Stat label="Power" value={state.motorKw.toFixed(2)} unit="kW" />
        {isAhu ? (
          <>
            <Stat label="Supply" value={state.supplyCfm} unit="CFM" tone={Math.abs(supplyPct - 100) > 10 ? 'text-amber-300' : undefined} />
            <Stat label="Return" value={state.returnCfm} unit="CFM" />
            <Stat label="% design" value={supplyPct.toFixed(0)} unit="%" tone={Math.abs(supplyPct - 100) > 10 ? 'text-amber-300' : 'text-emerald-300'} />
            <Stat label="Fresh air" value={state.freshAirCfm} unit="CFM" />
            <Stat label="Bleed air" value={state.bleedCfm} unit="CFM" />
            <Stat label="Fan ΔP" value={state.fanDpPa.toFixed(0)} unit="Pa" />
            <Stat label="Supply static" value={state.supplyStaticPa.toFixed(0)} unit="Pa" />
            <Stat label="Return static" value={state.returnStaticPa.toFixed(0)} unit="Pa" />
            <Stat label="Filters + coil" value={state.internalDpPa.toFixed(0)} unit="Pa" />
          </>
        ) : (
          <Stat label="Exhaust" value={state.returnCfm} unit="CFM" />
        )}
      </div>

      <div className="space-y-2">
        <Slider label="VFD frequency" unit=" Hz" min={20} max={60} step={0.5} value={control.hz} design={design.hz} onChange={(hz) => onChange({ hz })} />
        {isAhu && (
          <>
            <Slider label="Fresh-air damper" min={0} max={100} value={control.freshAirPct} design={design.freshAirPct} onChange={(freshAirPct) => onChange({ freshAirPct })} />
            <Slider label="Bleed-air damper" min={0} max={100} value={control.bleedPct} design={design.bleedPct} onChange={(bleedPct) => onChange({ bleedPct })} />
            <Slider label="Filter loading (clean → change-out)" min={0} max={100} value={control.filterLoadingPct} design={design.filterLoadingPct} onChange={(filterLoadingPct) => onChange({ filterLoadingPct })} />
          </>
        )}
      </div>

      <div className="mt-2 text-[10px] text-slate-500">Serves: {served.map((r) => r.shortName).join(', ')}</div>
    </div>
  );
}

// ============= Doors =============

export function DoorList({
  facility,
  network,
  onToggle,
}: {
  facility: Facility;
  network: NetworkState;
  onToggle: (id: string) => void;
}) {
  return (
    <div className="space-y-1">
      {network.doors
        .filter((d) => facility.doors.find((x) => x.id === d.doorId)?.rooms[1] !== null)
        .map((d) => {
          const door = facility.doors.find((x) => x.id === d.doorId)!;
          const from = d.flowCfm >= 0 ? door.rooms[0] : door.rooms[1];
          const to = d.flowCfm >= 0 ? door.rooms[1] : door.rooms[0];
          return (
            <div key={d.doorId} className="flex items-center gap-2 rounded-md border border-slate-800 bg-slate-900/50 px-2 py-1.5 text-[11px]">
              <button
                onClick={() => onToggle(d.doorId)}
                className={`w-14 shrink-0 rounded px-1 py-0.5 text-[10px] font-semibold ${d.open ? 'bg-sky-500/25 text-sky-200' : 'bg-slate-700 text-slate-300'}`}
              >
                {d.open ? 'OPEN' : 'CLOSED'}
              </button>
              <div className="min-w-0 flex-1">
                <div className="truncate text-slate-200">
                  {roomName(facility, door.rooms[0])} ↔ {roomName(facility, door.rooms[1])}
                </div>
                <div className="text-slate-500">
                  {Math.abs(d.flowCfm)} CFM {roomName(facility, from)} → {roomName(facility, to)}
                </div>
              </div>
              <div className="text-right font-mono">
                <div className={doorTone(d.status)}>
                  {d.dpPa.toFixed(1)} <span className="text-slate-500">/ {d.designDpPa}</span>
                </div>
                <div className={`text-[9px] ${doorTone(d.status)}`}>{doorLabel(d.status)}</div>
              </div>
            </div>
          );
        })}
    </div>
  );
}

// ============= Selected room =============

export function RoomDetail({
  facility,
  room,
  state,
  network,
  controls,
  design,
  cfd,
  onDamper,
  onTour,
  roomCfd,
  onRunRoomCfd,
  onSmokeTest,
  onEditTerminals,
  onClose,
}: {
  facility: Facility;
  room: FacilityRoom;
  state: RoomState;
  network: NetworkState;
  controls: HvacControls;
  design: HvacControls;
  cfd: FacilityResults | null;
  onDamper: (kind: 'supply' | 'return', pct: number) => void;
  onTour: () => void;
  /** Fine-grid CFD of just this room */
  roomCfd: { state: 'none' | 'running' | 'fresh' | 'stale'; progress?: number; busy: boolean };
  onRunRoomCfd: () => void;
  onSmokeTest: () => void;
  onEditTerminals: () => void;
  onClose: () => void;
}) {
  const hv = room.hvac;
  const doors = network.doors.filter((d) => {
    const door = facility.doors.find((x) => x.id === d.doorId);
    return door && (door.rooms[0] === room.id || door.rooms[1] === room.id);
  });
  const cfdRoom = cfd?.rooms.find((r) => r.roomId === room.id);
  const terminals = Object.entries(hv.terminals).map(([k, v]) => `${v}× ${k}`).join(' · ');

  return (
    <div className="w-80 rounded-xl border border-slate-700 bg-slate-950/95 p-3 text-[12px] shadow-2xl backdrop-blur">
      <div className="mb-2 flex items-start justify-between">
        <div>
          <div className="text-sm font-semibold text-white">{room.name}</div>
          <div className="text-[11px] text-slate-400">
            RDS #{room.rdsNo} · {hv.ahu} · Grade {hv.areaClass} · {room.nominal.length} × {room.nominal.width} × {room.height} m
          </div>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-white">✕</button>
      </div>

      <div className="mb-2 grid grid-cols-2 gap-1.5">
        <button
          onClick={onTour}
          className="rounded-md bg-cyan-500/15 py-1.5 text-[12px] font-semibold text-cyan-200 hover:bg-cyan-500/25"
        >
          🚶 Walk inside
        </button>
        <button
          onClick={onRunRoomCfd}
          disabled={roomCfd.busy}
          title="Fine-grid CFD of this room, with door leakage from the pressure model"
          className="rounded-md bg-blue-500/15 py-1.5 text-[12px] font-semibold text-blue-200 hover:bg-blue-500/25 disabled:opacity-50"
        >
          {roomCfd.state === 'running'
            ? `Room CFD ${roomCfd.progress ?? 0}%`
            : roomCfd.state === 'fresh'
              ? '✓ Room CFD'
              : roomCfd.state === 'stale'
                ? '↻ Re-run room'
                : '▶ Room CFD'}
        </button>
        <button
          onClick={onSmokeTest}
          disabled={roomCfd.busy && roomCfd.state !== 'fresh'}
          className="col-span-2 rounded-md bg-slate-100 py-1.5 text-[12px] font-semibold text-slate-900 hover:bg-white disabled:opacity-50"
        >
          💨 Run smoke test
        </button>
        <button
          onClick={onEditTerminals}
          className="col-span-2 rounded-md bg-slate-800 py-1.5 text-[12px] font-semibold text-slate-100 hover:bg-slate-700"
        >
          ✥ Move blowers &amp; suckers
        </button>
      </div>

      <div className="mb-2 grid grid-cols-3 gap-1.5">
        <Stat label="Pressure" value={`${state.pressurePa >= 0 ? '+' : ''}${state.pressurePa.toFixed(1)}`} unit="Pa" tone={alarmTone(state.alarm)} />
        <Stat label="Design" value={state.designPa ?? '—'} unit={state.designPa !== null ? 'Pa' : undefined} />
        <Stat label="ACPH" value={state.achievedAcph} unit={`/${hv.acph}`} />
        <Stat label="Supply" value={state.supplyCfm} unit={`/${Math.round(hv.supplyCfm)}`} />
        <Stat label="Return" value={state.returnCfm} unit={`/${Math.round(hv.returnCfm)}`} />
        <Stat label="Door leak out" value={state.leakageOutCfm} unit="CFM" />
        {state.exhaustCfm > 0 && <Stat label="Exhaust" value={state.exhaustCfm} unit="CFM" />}
      </div>

      {state.hepa && (
        <div className="mb-2">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">HEPA terminal</div>
          <div className="grid grid-cols-3 gap-1.5">
            <Stat label="Plenum static" value={state.hepa.plenumStaticPa.toFixed(0)} unit="Pa" />
            <Stat label="Filter ΔP" value={state.hepa.filterDpPa.toFixed(0)} unit="Pa" tone={state.hepa.filterDpPa > 400 ? 'text-red-300' : undefined} />
            <Stat label="Face vel." value={state.hepa.faceVelocity.toFixed(2)} unit="m/s" tone={state.hepa.faceVelocity < 0.36 || state.hepa.faceVelocity > 0.54 ? 'text-amber-300' : undefined} />
          </div>
        </div>
      )}

      <div className="mb-2 space-y-2">
        {state.supplyDamperPct !== null && (
          <Slider label="Supply damper open" min={2} max={100} step={0.5} value={controls.supplyDamperPct[room.id]} design={design.supplyDamperPct[room.id]} onChange={(v) => onDamper('supply', v)} />
        )}
        {state.returnDamperPct !== null && (
          <Slider label="Return riser damper open" min={2} max={100} step={0.5} value={controls.returnDamperPct[room.id]} design={design.returnDamperPct[room.id]} onChange={(v) => onDamper('return', v)} />
        )}
      </div>

      <div className="mb-2">
        <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">Doors</div>
        {doors.map((d) => {
          const door = facility.doors.find((x) => x.id === d.doorId)!;
          const other = door.rooms[0] === room.id ? door.rooms[1] : door.rooms[0];
          const dp = door.rooms[0] === room.id ? d.dpPa : -d.dpPa;
          return (
            <div key={d.doorId} className="flex justify-between text-[11px]">
              <span className="text-slate-300">→ {roomName(facility, other)}</span>
              <span className={`font-mono ${doorTone(d.status)}`}>
                {dp >= 0 ? '+' : ''}
                {dp.toFixed(1)} Pa {d.open ? '(open)' : ''}
              </span>
            </div>
          );
        })}
      </div>

      <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">RDS</div>
      <div className="grid grid-cols-2 gap-x-3 text-[11px] text-slate-400">
        <span>Temp / RH</span>
        <span className="text-right text-slate-300">{hv.temperatureF}°F / {hv.rhPercent}%</span>
        <span>Occupancy</span>
        <span className="text-right text-slate-300">{hv.occupancy}</span>
        <span>Equipment</span>
        <span className="text-right text-slate-300">{hv.equipmentKw} kW</span>
        <span>Fresh air</span>
        <span className="text-right text-slate-300">{hv.freshAirCfm} CFM</span>
        <span>Infil. / exfil.</span>
        <span className="text-right text-slate-300">{hv.infiltrationCfm} / {hv.exfiltrationCfm} CFM</span>
        <span>Terminals</span>
        <span className="text-right text-slate-300">{terminals || '—'}</span>
      </div>

      {cfdRoom && (
        <>
          <div className="mb-1 mt-2 text-[10px] uppercase tracking-wide text-slate-500">CFD</div>
          <div className="grid grid-cols-3 gap-1.5">
            <Stat label="Work-zone" value={cfdRoom.workingZoneSpeed.toFixed(2)} unit="m/s" />
            <Stat label="Stagnant" value={(cfdRoom.stagnantFraction * 100).toFixed(0)} unit="%" tone={cfdRoom.stagnantFraction > 0.35 ? 'text-amber-300' : undefined} />
            <Stat label="Mean" value={cfdRoom.meanSpeed.toFixed(2)} unit="m/s" />
          </div>
        </>
      )}
    </div>
  );
}
