'use client';

import { Facility, FacilityObject, ObjectKind, PlacedTerminal } from '@/lib/facility/types';
import { TERMINALS, roomCentroid } from '@/lib/facility/geometry';

const TEMPLATES: Record<ObjectKind, { name: string; width: number; depth: number; height: number }> = {
  equipment: { name: 'Machine', width: 1.2, depth: 1.0, height: 1.6 },
  table: { name: 'Work bench', width: 1.8, depth: 0.8, height: 0.9 },
  cabinet: { name: 'Cabinet / rack', width: 1.2, depth: 0.5, height: 1.9 },
  person: { name: 'Operator', width: 0.45, depth: 0.3, height: 1.7 },
};

function NumberField({ label, value, onChange, step = 0.05 }: { label: string; value: number; onChange: (v: number) => void; step?: number }) {
  return (
    <label className="flex items-center justify-between gap-2 text-[11px]">
      <span className="text-slate-400">{label}</span>
      <input
        type="number"
        step={step}
        min={0.1}
        value={Number(value.toFixed(2))}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v) && v > 0) onChange(v);
        }}
        className="w-20 rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 text-right font-mono text-slate-100"
      />
    </label>
  );
}

/**
 * Edit-mode panel: add, size and remove the things standing in the rooms.
 * Dragging happens in the 3D view (objects on the floor, terminals on the
 * ceiling or along their wall).
 */
export default function LayoutEditor({
  facility,
  roomId,
  objects,
  selected,
  movedTerminals,
  onSelect,
  onChange,
  onResetObjects,
  onResetTerminals,
  onClose,
  terminals,
  selectedTerminal,
  movedTerminalIds,
  onSelectTerminal,
  onMoveTerminal,
  onResetTerminal,
}: {
  facility: Facility;
  roomId: string | null;
  objects: FacilityObject[];
  selected: string | null;
  movedTerminals: number;
  onSelect: (id: string | null) => void;
  onChange: (objects: FacilityObject[]) => void;
  onResetObjects: () => void;
  onResetTerminals: () => void;
  onClose: () => void;
  /** Terminals of the whole floor, as currently placed */
  terminals: PlacedTerminal[];
  selectedTerminal: string | null;
  movedTerminalIds: string[];
  onSelectTerminal: (id: string | null) => void;
  onMoveTerminal: (id: string, x: number, y: number) => void;
  onResetTerminal: (id: string) => void;
}) {
  const room = roomId ? facility.rooms.find((r) => r.id === roomId) : null;
  const inRoom = room ? objects.filter((o) => o.roomId === room.id) : [];
  const sel = objects.find((o) => o.id === selected) ?? null;
  const roomTerminals = room ? terminals.filter((t) => t.roomId === room.id && !t.auto) : [];
  const blowers = roomTerminals.filter((t) => t.role === 'supply');
  const suckers = roomTerminals.filter((t) => t.role !== 'supply');
  const selT = terminals.find((t) => t.id === selectedTerminal) ?? null;
  const wallOf = (t: PlacedTerminal) => {
    const n = t.normal ?? { x: 0, y: 0 };
    return n.y > 0.5 ? 'north wall' : n.y < -0.5 ? 'south wall' : n.x > 0.5 ? 'west wall' : 'east wall';
  };
  const describe = (t: PlacedTerminal) =>
    `${TERMINALS[t.code].label}${t.mount === 'ceiling' ? '' : `, ${wallOf(t)}`} · ${Math.round(t.cfm)} CFM`;

  const add = (kind: ObjectKind) => {
    if (!room) return;
    const c = roomCentroid(room);
    const t = TEMPLATES[kind];
    // Next free number among the objects added here.
    const used = objects.map((o) => Number(/^u-(\d+)$/.exec(o.id)?.[1] ?? 0));
    const obj: FacilityObject = { id: `u-${Math.max(0, ...used) + 1}`, roomId: room.id, kind, ...t, x: c.x, y: c.y };
    onChange([...objects, obj]);
    onSelect(obj.id);
  };
  const patch = (id: string, p: Partial<FacilityObject>) => onChange(objects.map((o) => (o.id === id ? { ...o, ...p } : o)));

  return (
    <div className="w-72 rounded-xl border border-cyan-500/40 bg-slate-950/95 p-3 text-[12px] shadow-2xl backdrop-blur">
      <div className="mb-2 flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-white">Edit layout</div>
          <div className="text-[11px] text-slate-400">Drag objects and terminals in the 3D view</div>
        </div>
        <button onClick={onClose} className="rounded bg-slate-800 px-2 py-0.5 text-[11px] hover:bg-slate-700">
          Done
        </button>
      </div>

      {!room ? (
        <p className="rounded-md bg-slate-900 p-2 text-slate-400">Click a room floor to add equipment, benches or people to it.</p>
      ) : (
        <>
          <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">Add to {room.shortName}</div>
          <div className="mb-3 grid grid-cols-2 gap-1">
            {(Object.keys(TEMPLATES) as ObjectKind[]).map((k) => (
              <button key={k} onClick={() => add(k)} className="rounded-md bg-slate-800 px-2 py-1 text-left hover:bg-slate-700">
                + {TEMPLATES[k].name}
              </button>
            ))}
          </div>
          <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">In this room ({inRoom.length})</div>
          <div className="mb-3 max-h-32 space-y-0.5 overflow-y-auto">
            {inRoom.map((o) => (
              <button
                key={o.id}
                onClick={() => onSelect(o.id)}
                className={`flex w-full justify-between rounded px-1.5 py-0.5 text-left ${o.id === selected ? 'bg-cyan-500/15 text-cyan-200' : 'hover:bg-slate-800'}`}
              >
                <span>{o.name}</span>
                <span className="font-mono text-[10px] text-slate-500">
                  {o.width}×{o.depth}×{o.height}
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      {room && (
        <div className="mb-3">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">
            Blowers — supply air in ({blowers.length})
          </div>
          <TerminalList items={blowers} selected={selectedTerminal} moved={movedTerminalIds} describe={describe} onSelect={onSelectTerminal} tone="text-sky-300" />
          <div className="mb-1 mt-2 text-[10px] uppercase tracking-wide text-slate-500">
            Suckers — return / exhaust air out ({suckers.length})
          </div>
          <TerminalList items={suckers} selected={selectedTerminal} moved={movedTerminalIds} describe={describe} onSelect={onSelectTerminal} tone="text-amber-300" />
        </div>
      )}

      {selT && (
        <div className="mb-3 space-y-1.5 rounded-md border border-cyan-500/40 p-2">
          <div className="text-[11px] text-cyan-200">{describe(selT)}</div>
          <div className="text-[10px] text-slate-500">
            {selT.mount === 'ceiling' ? 'Slides anywhere on the ceiling of its room.' : 'Slides along its room’s walls (snaps to the nearest wall).'}
          </div>
          <NumberField label="X across the plan (m)" step={0.1} value={selT.x} onChange={(v) => onMoveTerminal(selT.id, v, selT.y)} />
          <NumberField label="Y down the plan (m)" step={0.1} value={selT.y} onChange={(v) => onMoveTerminal(selT.id, selT.x, v)} />
          <div className="grid grid-cols-4 gap-1 pt-1">
            {(
              [
                ['←', -0.1, 0],
                ['→', 0.1, 0],
                ['↑', 0, -0.1],
                ['↓', 0, 0.1],
              ] as [string, number, number][]
            ).map(([label, dx, dy]) => (
              <button
                key={label}
                onClick={() => onMoveTerminal(selT.id, selT.x + dx, selT.y + dy)}
                className="rounded bg-slate-800 py-0.5 hover:bg-slate-700"
                title="Nudge 10 cm"
              >
                {label}
              </button>
            ))}
          </div>
          <button
            onClick={() => onResetTerminal(selT.id)}
            disabled={!movedTerminalIds.includes(selT.id)}
            className="w-full rounded bg-slate-800 py-0.5 hover:bg-slate-700 disabled:opacity-40"
          >
            Back to design position
          </button>
        </div>
      )}

      {sel && (
        <div className="mb-3 space-y-1.5 rounded-md border border-slate-800 p-2">
          <input
            value={sel.name}
            onChange={(e) => patch(sel.id, { name: e.target.value })}
            className="w-full rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 text-slate-100"
          />
          <NumberField label="Width (m)" value={sel.width} onChange={(v) => patch(sel.id, { width: v })} />
          <NumberField label="Depth (m)" value={sel.depth} onChange={(v) => patch(sel.id, { depth: v })} />
          <NumberField label="Height (m)" value={sel.height} onChange={(v) => patch(sel.id, { height: v })} />
          <div className="flex gap-1 pt-1">
            <button
              onClick={() => patch(sel.id, { width: sel.depth, depth: sel.width })}
              className="flex-1 rounded bg-slate-800 py-0.5 hover:bg-slate-700"
            >
              Rotate 90°
            </button>
            <button
              onClick={() => {
                onChange(objects.filter((o) => o.id !== sel.id));
                onSelect(null);
              }}
              className="flex-1 rounded bg-red-500/15 py-0.5 text-red-200 hover:bg-red-500/25"
            >
              Delete
            </button>
          </div>
        </div>
      )}

      <div className="flex gap-1 text-[11px]">
        <button onClick={onResetObjects} className="flex-1 rounded bg-slate-800 py-1 hover:bg-slate-700">
          Clear objects
        </button>
        <button
          onClick={onResetTerminals}
          disabled={movedTerminals === 0}
          className="flex-1 rounded bg-slate-800 py-1 hover:bg-slate-700 disabled:opacity-40"
        >
          Reset terminals ({movedTerminals})
        </button>
      </div>
      <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
        Drag a blower or sucker (or the coloured ring under it) in the 3D view, or type a position. After changes, re-run
        the room CFD (or the smoke test, which does it for you) to see the new airflow.
      </p>
    </div>
  );
}

function TerminalList({
  items,
  selected,
  moved,
  describe,
  onSelect,
  tone,
}: {
  items: PlacedTerminal[];
  selected: string | null;
  moved: string[];
  describe: (t: PlacedTerminal) => string;
  onSelect: (id: string | null) => void;
  tone: string;
}) {
  if (items.length === 0) return <div className="text-[11px] text-slate-500">None in this room</div>;
  return (
    <div className="space-y-0.5">
      {items.map((t) => (
        <button
          key={t.id}
          onClick={() => onSelect(t.id === selected ? null : t.id)}
          className={`flex w-full justify-between rounded px-1.5 py-0.5 text-left text-[11px] ${t.id === selected ? 'bg-cyan-500/15 text-cyan-200' : `${tone} hover:bg-slate-800`}`}
        >
          <span className="truncate">{describe(t)}</span>
          {moved.includes(t.id) && <span className="ml-1 text-[10px] text-slate-400">moved</span>}
        </button>
      ))}
    </div>
  );
}
