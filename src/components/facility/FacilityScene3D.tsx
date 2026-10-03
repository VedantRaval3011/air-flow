'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, ThreeEvent, useFrame, useThree } from '@react-three/fiber';
import { Html, Line, OrbitControls, PointerLockControls } from '@react-three/drei';
import type { PointerLockControls as PointerLockControlsImpl } from 'three-stdlib';
import * as THREE from 'three';
import { Facility, FacilityObject, FacilityResults, PlacedTerminal, SpeedSection, SpeedSlice } from '@/lib/facility/types';
import {
  WALL_THICKNESS,
  WallSegment,
  ahuColor,
  CLASS_COLORS,
  doorsOnWall,
  pressureColor,
  roomAt,
  roomCentroid,
} from '@/lib/facility/geometry';
import { speedRgb } from '@/lib/facility/colormap';
import SmokeTest3D, { SmokeStats, SmokeTestSetup } from './SmokeTest3D';
import AirPaths3D from './AirPaths3D';
import type { AirPath, Sink, Source } from '@/lib/facility/smoke';

/** Window event that asks the walk-through to capture the mouse. */
export const TOUR_LOCK_EVENT = 'facility-tour-lock';
import { NetworkState } from '@/lib/facility/network';
import { EYE_HEIGHT, RUN_SPEED, WALK_SPEED, blocked, collisionRects, spawnFor } from '@/lib/facility/tour';

export type ColorMode = 'ahu' | 'class' | 'pressure' | 'deviation';

export interface SceneLayers {
  walls: 'full' | 'cut';
  labels: boolean;
  terminals: boolean;
  doorDp: boolean;
  streamlines: boolean;
  particles: boolean;
  vectors: boolean;
  deadZones: boolean;
  /** Colour map of air speed at working height */
  speedMap: boolean;
  /** Vertical speed section through studied rooms */
  section: boolean;
  /** Thick supply-to-suction air paths for the room in focus */
  airPaths: boolean;
}

/** Walker position and look direction in plan coordinates. */
export interface PlayerPose {
  x: number;
  y: number;
  /** Unit look direction on the plan */
  fx: number;
  fy: number;
}

export interface TourRequest {
  roomId: string;
  /** Changes on every teleport so the same room can be re-entered */
  nonce: number;
}

interface Props {
  facility: Facility;
  walls: WallSegment[];
  terminals: PlacedTerminal[];
  network: NetworkState;
  colorMode: ColorMode;
  layers: SceneLayers;
  results: FacilityResults | null;
  selectedRoom: string | null;
  onSelectRoom: (id: string | null) => void;
  onToggleDoor: (id: string) => void;
  tour?: TourRequest | null;
  onPlayer?: (pose: PlayerPose) => void;
  onLockChange?: (locked: boolean) => void;
  contextWalls: WallSegment[];
  objects: FacilityObject[];
  slices: SpeedSlice[];
  sections: SpeedSection[];
  /** Objects and terminals can be dragged */
  editMode: boolean;
  selectedObject: string | null;
  onSelectObject: (id: string | null) => void;
  onMoveObject: (id: string, x: number, y: number) => void;
  onMoveTerminal: (id: string, x: number, y: number) => void;
  /** A running smoke test, and the room it is in */
  smoke?: (SmokeTestSetup & { roomId: string }) | null;
  onSmokeStats?: (s: SmokeStats) => void;
  /** Supply air shown as moving balls in the room being walked through */
  ambientAir?: SmokeTestSetup | null;
  selectedTerminal?: string | null;
  onSelectTerminal?: (id: string | null) => void;
  /** Air paths of one room (walked through, or selected in the overview) */
  airPaths?: { paths: AirPath[]; sources: Source[]; sinks: Sink[]; shares: number[] } | null;
}

/** Plan (x, y, z-up) → three.js (x, y-up, z). */
const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, z, y);

/** Air speed → colour on the shared scale (see lib/facility/colormap). */
function speedColor(speed: number): THREE.Color {
  const [r, g, b] = speedRgb(speed);
  return new THREE.Color(r, g, b);
}

function deviationColor(pa: number, design: number | null): string {
  if (design === null) return '#475569';
  const err = Math.abs(pa - design);
  const band = Math.max(5, 0.25 * design);
  if (err <= band * 0.5) return '#16a34a';
  if (err <= band) return '#eab308';
  return '#dc2626';
}

// ============= Building =============

function Floors({
  facility,
  network,
  colorMode,
  selectedRoom,
  onSelectRoom,
  neutral,
}: Pick<Props, 'facility' | 'network' | 'colorMode' | 'selectedRoom' | 'onSelectRoom'> & { neutral: boolean }) {
  const state = useMemo(() => new Map(network.rooms.map((r) => [r.roomId, r])), [network]);
  return (
    <group>
      {facility.rooms.map((room) => {
        const live = state.get(room.id);
        const color = neutral
          ? '#9aa4b1'
          : colorMode === 'ahu'
            ? ahuColor(room.hvac.ahu)
            : colorMode === 'class'
              ? CLASS_COLORS[room.hvac.areaClass] ?? '#64748b'
              : colorMode === 'pressure'
                ? pressureColor(live?.pressurePa ?? 0)
                : deviationColor(live?.pressurePa ?? 0, live?.designPa ?? null);
        const selected = selectedRoom === room.id;
        return room.rects.map((r, i) => (
          <mesh
            key={`${room.id}-${i}`}
            position={[(r.x0 + r.x1) / 2, 0.01, (r.y0 + r.y1) / 2]}
            rotation={[-Math.PI / 2, 0, 0]}
            onClick={(e: ThreeEvent<MouseEvent>) => {
              e.stopPropagation();
              onSelectRoom(selected ? null : room.id);
            }}
          >
            <planeGeometry args={[r.x1 - r.x0, r.y1 - r.y0]} />
            <meshStandardMaterial
              color={color}
              transparent
              opacity={selected ? 0.95 : 0.7}
              emissive={selected ? color : '#000000'}
              emissiveIntensity={selected ? 0.35 : 0}
            />
          </mesh>
        ));
      })}
    </group>
  );
}

function Walls({
  facility,
  walls,
  cut,
  solid,
  focusRoom,
  network,
  onToggleDoor,
}: {
  facility: Facility;
  walls: WallSegment[];
  cut: boolean;
  solid: boolean;
  /** Room being studied: its walls go full height and see-through, the rest are cut low */
  focusRoom: string | null;
  network: NetworkState;
  onToggleDoor: (id: string) => void;
}) {
  const doorState = useMemo(() => new Map(network.doors.map((d) => [d.doorId, d])), [network]);
  const cutHeight = 1.2;

  const pieces = useMemo(() => {
    const out: { key: string; x: number; y: number; z: number; sx: number; sy: number; sz: number; exterior: boolean; focus: boolean }[] = [];
    walls.forEach((w, wi) => {
      const exterior = w.lowRoom === null || w.highRoom === null;
      const focus = focusRoom !== null && (w.lowRoom === focusRoom || w.highRoom === focusRoom);
      const top = focus ? w.height : cut || focusRoom !== null ? Math.min(cutHeight, w.height) : w.height;
      const doors = doorsOnWall(w, facility.doors).sort((a, b) => (w.axis === 'x' ? a.x - b.x : a.y - b.y));
      const spans: { from: number; to: number; z0: number; z1: number }[] = [];
      let cursor = w.from;
      for (const d of doors) {
        const c = w.axis === 'x' ? d.x : d.y;
        const d0 = Math.max(w.from, c - d.width / 2);
        const d1 = Math.min(w.to, c + d.width / 2);
        if (d0 > cursor) spans.push({ from: cursor, to: d0, z0: 0, z1: top });
        if (top > d.height) spans.push({ from: d0, to: d1, z0: d.height, z1: top }); // lintel
        cursor = Math.max(cursor, d1);
      }
      if (cursor < w.to) spans.push({ from: cursor, to: w.to, z0: 0, z1: top });
      spans.forEach((s, si) => {
        const len = s.to - s.from;
        if (len <= 1e-3 || s.z1 - s.z0 <= 1e-3) return;
        const mid = (s.from + s.to) / 2;
        const t = WALL_THICKNESS;
        out.push({
          key: `${wi}-${si}`,
          x: w.axis === 'x' ? mid : w.at,
          y: w.axis === 'x' ? w.at : mid,
          z: (s.z0 + s.z1) / 2,
          sx: w.axis === 'x' ? len + t : t,
          sy: w.axis === 'x' ? t : len + t,
          sz: s.z1 - s.z0,
          exterior,
          focus,
        });
      });
    });
    return out;
  }, [walls, facility.doors, cut, focusRoom]);

  return (
    <group>
      {pieces.map((p) => (
        <mesh key={p.key} position={[p.x, p.z, p.y]}>
          <boxGeometry args={[p.sx, p.sz, p.sy]} />
          <meshStandardMaterial
            color={p.exterior ? '#cbd5e1' : '#e2e8f0'}
            transparent={!solid}
            opacity={solid ? 0.95 : p.focus ? 0.14 : cut || focusRoom !== null ? 0.95 : 0.42}
            depthWrite={solid || (!p.focus && (cut || focusRoom !== null))}
          />
        </mesh>
      ))}
      {facility.doors.map((d) => {
        const st = doorState.get(d.id);
        const open = st?.open ?? false;
        const exterior = d.rooms[1] === null;
        const color =
          exterior ? '#64748b'
            : st?.status === 'open' ? '#38bdf8'
              : st?.status === 'reversed' ? '#ef4444'
                : st?.status === 'low-dp' ? '#f59e0b'
                  : '#94a3b8';
        const leafH = cut ? Math.min(cutHeight, d.height) : d.height;
        // Hinge at the low end of the opening; an open leaf swings 90°.
        const hinge = d.axis === 'x' ? v3(d.x - d.width / 2, d.y, 0) : v3(d.x, d.y - d.width / 2, 0);
        const rotation = open ? (d.axis === 'x' ? -Math.PI / 2 : Math.PI / 2) : 0;
        return (
          <group key={d.id} position={hinge} rotation={[0, rotation, 0]}>
            <mesh
              position={d.axis === 'x' ? [d.width / 2, leafH / 2, 0] : [0, leafH / 2, d.width / 2]}
              onClick={(e: ThreeEvent<MouseEvent>) => {
                e.stopPropagation();
                if (!exterior) onToggleDoor(d.id);
              }}
              onPointerOver={(e) => {
                e.stopPropagation();
                if (!exterior) document.body.style.cursor = 'pointer';
              }}
              onPointerOut={() => (document.body.style.cursor = '')}
            >
              <boxGeometry args={d.axis === 'x' ? [d.width - 0.04, leafH, 0.05] : [0.05, leafH, d.width - 0.04]} />
              <meshStandardMaterial color={color} transparent opacity={0.85} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

type DragStart = (kind: 'object' | 'terminal', id: string, height: number) => void;

function Terminals({
  terminals,
  editMode,
  onDragStart,
  neutral,
  selected,
  onSelect,
}: {
  terminals: PlacedTerminal[];
  editMode: boolean;
  onDragStart: DragStart;
  neutral: boolean;
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  return (
    <group>
      {editMode && <TerminalHandles terminals={terminals} selected={selected} onSelect={onSelect} onDragStart={onDragStart} />}
      {terminals.map((t) => {
        const color = neutral
          ? t.role === 'supply'
            ? '#f8fafc'
            : '#6b7280'
          : t.role === 'supply'
            ? t.code.startsWith('H')
              ? '#f8fafc'
              : '#7dd3fc'
            : t.role === 'exhaust'
              ? '#fda4af'
              : '#fbbf24';
        const isSel = selected === t.id;
        const grab = editMode
          ? {
              onPointerDown: (e: ThreeEvent<PointerEvent>) => {
                e.stopPropagation();
                onSelect(t.id);
                onDragStart('terminal', t.id, t.mount === 'ceiling' ? t.z : 0.02);
              },
            }
          : {};
        if (t.mount === 'ceiling') {
          return (
            <mesh key={t.id} position={[t.x, t.z - 0.02, t.y]} {...grab}>
              <boxGeometry args={[t.width, 0.04, t.depth]} />
              <meshStandardMaterial
                color={isSel ? '#22d3ee' : color}
                emissive={isSel ? '#22d3ee' : color}
                emissiveIntensity={isSel ? 0.8 : t.role === 'supply' ? 0.5 : 0.15}
              />
            </mesh>
          );
        }
        const alongX = (t.normal?.x ?? 0) === 0;
        return (
          <mesh key={t.id} position={[t.x, t.z, t.y]} {...grab}>
            <boxGeometry args={alongX ? [t.width, t.depth, 0.04] : [0.04, t.depth, t.width]} />
            <meshStandardMaterial
              color={isSel ? '#22d3ee' : t.auto ? '#a78bfa' : color}
              emissive={isSel ? '#22d3ee' : color}
              emissiveIntensity={isSel ? 0.8 : 0.2}
            />
          </mesh>
        );
      })}
    </group>
  );
}

/**
 * Edit-mode grab handles on the floor: one per terminal, blue for supply
 * ("blowers"), amber for return / exhaust ("suckers"), with a drop line to
 * ceiling terminals so they can be moved from any viewpoint.
 */
function TerminalHandles({
  terminals,
  selected,
  onSelect,
  onDragStart,
}: {
  terminals: PlacedTerminal[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  onDragStart: DragStart;
}) {
  return (
    <group>
      {terminals.map((t) => {
        const n = t.normal ?? { x: 0, y: 0 };
        const hx = t.mount === 'ceiling' ? t.x : t.x + n.x * 0.35;
        const hy = t.mount === 'ceiling' ? t.y : t.y + n.y * 0.35;
        const color = selected === t.id ? '#22d3ee' : t.role === 'supply' ? '#38bdf8' : '#f59e0b';
        return (
          <group key={`h-${t.id}`}>
            <mesh
              position={[hx, 0.03, hy]}
              rotation={[-Math.PI / 2, 0, 0]}
              onPointerDown={(e: ThreeEvent<PointerEvent>) => {
                e.stopPropagation();
                onSelect(t.id);
                onDragStart('terminal', t.id, 0.03);
              }}
              onPointerOver={() => (document.body.style.cursor = 'grab')}
              onPointerOut={() => (document.body.style.cursor = '')}
            >
              <ringGeometry args={[0.1, 0.18, 24]} />
              <meshBasicMaterial color={color} side={THREE.DoubleSide} />
            </mesh>
            {t.mount === 'ceiling' && (
              <Line points={[[t.x, 0.03, t.y], [t.x, t.z - 0.05, t.y]]} color={color} lineWidth={1} transparent opacity={0.5} dashed dashSize={0.15} gapSize={0.1} />
            )}
          </group>
        );
      })}
    </group>
  );
}

const OBJECT_COLORS: Record<FacilityObject['kind'], string> = {
  equipment: '#94a3b8',
  table: '#a8a29e',
  person: '#fcd34d',
  cabinet: '#64748b',
};

function Objects({
  objects,
  editMode,
  selected,
  onSelect,
  onDragStart,
  neutral,
}: {
  objects: FacilityObject[];
  editMode: boolean;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onDragStart: DragStart;
  neutral: boolean;
}) {
  return (
    <group>
      {objects.map((o) => {
        const isSel = selected === o.id;
        // In a smoke study people are gowned and equipment is plain steel.
        const color = neutral ? (o.kind === 'person' ? '#eef2f6' : '#b6bec8') : OBJECT_COLORS[o.kind];
        const handlers = {
          onPointerDown: (e: ThreeEvent<PointerEvent>) => {
            if (!editMode) return;
            e.stopPropagation();
            onSelect(o.id);
            onDragStart('object', o.id, 0.02);
          },
        };
        if (o.kind === 'person') {
          const r = Math.max(o.width, o.depth) / 2;
          return (
            <group key={o.id} position={[o.x, 0, o.y]} {...handlers}>
              <mesh position={[0, (o.height - 0.25) / 2, 0]}>
                <cylinderGeometry args={[r * 0.8, r * 0.7, o.height - 0.25, 14]} />
                <meshStandardMaterial color={color} emissive={isSel ? '#22d3ee' : '#000'} emissiveIntensity={isSel ? 0.6 : 0} />
              </mesh>
              <mesh position={[0, o.height - 0.12, 0]}>
                <sphereGeometry args={[0.12, 14, 14]} />
                <meshStandardMaterial color="#f5d0a9" />
              </mesh>
            </group>
          );
        }
        return (
          <mesh key={o.id} position={[o.x, o.height / 2, o.y]} {...handlers}>
            <boxGeometry args={[o.width, o.height, o.depth]} />
            <meshStandardMaterial
              color={color}
              emissive={isSel ? '#22d3ee' : '#000'}
              emissiveIntensity={isSel ? 0.5 : 0}
              transparent
              opacity={0.92}
            />
          </mesh>
        );
      })}
    </group>
  );
}

/** Rooms on the zoning drawing that are not in the RDS: drawn for context only. */
function ContextAreas({ facility, walls, labels }: { facility: Facility; walls: WallSegment[]; labels: boolean }) {
  return (
    <group>
      {(facility.contextRooms ?? []).map((room) => (
        <group key={room.id}>
          {room.rects.map((r, i) => (
            <mesh key={i} position={[(r.x0 + r.x1) / 2, 0.005, (r.y0 + r.y1) / 2]} rotation={[-Math.PI / 2, 0, 0]}>
              <planeGeometry args={[r.x1 - r.x0, r.y1 - r.y0]} />
              <meshStandardMaterial color="#334155" transparent opacity={0.55} />
            </mesh>
          ))}
          {labels && (
            <Html position={[(room.rects[0].x0 + room.rects[0].x1) / 2, 0.3, (room.rects[0].y0 + room.rects[0].y1) / 2]} center distanceFactor={20} zIndexRange={[4, 0]}>
              <div className="pointer-events-none select-none whitespace-nowrap rounded bg-slate-900/70 px-1.5 py-0.5 text-[10px] text-slate-400">
                {room.name}
              </div>
            </Html>
          )}
        </group>
      ))}
      {walls.map((w, i) => {
        const len = w.to - w.from;
        const mid = (w.from + w.to) / 2;
        const h = Math.min(w.height, 1.0);
        return (
          <mesh key={i} position={w.axis === 'x' ? [mid, h / 2, w.at] : [w.at, h / 2, mid]}>
            <boxGeometry args={w.axis === 'x' ? [len + WALL_THICKNESS, h, WALL_THICKNESS] : [WALL_THICKNESS, h, len + WALL_THICKNESS]} />
            <meshStandardMaterial color="#475569" transparent opacity={0.6} />
          </mesh>
        );
      })}
    </group>
  );
}

function RoomLabels({ facility, network, selectedRoom }: { facility: Facility; network: NetworkState; selectedRoom: string | null }) {
  const state = useMemo(() => new Map(network.rooms.map((r) => [r.roomId, r])), [network]);
  return (
    <group>
      {facility.rooms.map((room) => {
        const c = roomCentroid(room);
        const live = state.get(room.id);
        const alarm = live?.alarm ?? 'none';
        const tone = alarm === 'ok' ? 'text-emerald-300' : alarm === 'none' ? 'text-slate-300' : 'text-red-300';
        return (
          <Html key={room.id} position={[c.x, room.height + 0.25, c.y]} center distanceFactor={16} zIndexRange={[10, 0]}>
            <div
              className={`pointer-events-none select-none whitespace-nowrap rounded-md border px-2 py-1 text-center shadow-lg ${
                selectedRoom === room.id ? 'border-cyan-400 bg-slate-900/95' : 'border-slate-600/60 bg-slate-900/80'
              }`}
            >
              <div className="text-[11px] font-semibold text-white">{room.shortName}</div>
              <div className={`text-[12px] font-mono ${tone}`}>
                {live ? `${live.pressurePa >= 0 ? '+' : ''}${live.pressurePa.toFixed(1)} Pa` : '—'}
                {live?.designPa !== null && live?.designPa !== undefined && (
                  <span className="text-slate-500"> / {live.designPa}</span>
                )}
              </div>
            </div>
          </Html>
        );
      })}
    </group>
  );
}

function DoorBadges({ facility, network, occlude }: { facility: Facility; network: NetworkState; occlude: boolean }) {
  return (
    <group>
      {network.doors.map((d) => {
        const door = facility.doors.find((x) => x.id === d.doorId);
        if (!door || door.rooms[1] === null) return null;
        // Only doors that hold a designed cascade, or that need attention.
        if (Math.abs(d.designDpPa) < 1 && d.status !== 'open' && Math.abs(d.dpPa) < 2) return null;
        const tone =
          d.status === 'open' ? 'border-sky-400 text-sky-200'
            : d.status === 'reversed' ? 'border-red-500 text-red-300'
              : d.status === 'low-dp' ? 'border-amber-400 text-amber-200'
                : 'border-slate-600 text-slate-300';
        return (
          <Html
            key={d.doorId}
            position={[door.x, door.height + 0.15, door.y]}
            center
            distanceFactor={14}
            zIndexRange={[5, 0]}
            occlude={occlude}
          >
            <div className={`pointer-events-none select-none whitespace-nowrap rounded border bg-slate-950/85 px-1 font-mono text-[10px] ${tone}`}>
              Δ{Math.abs(d.dpPa).toFixed(1)}
            </div>
          </Html>
        );
      })}
    </group>
  );
}

// ============= CFD overlays =============

function Streamlines({ results, faint }: { results: FacilityResults; faint: boolean }) {
  const lines = useMemo(
    () =>
      results.streamlines.map((s) => {
        const pts: THREE.Vector3[] = [];
        for (let i = 0; i < s.points.length; i += 3) pts.push(v3(s.points[i], s.points[i + 1], s.points[i + 2]));
        return { id: s.id, pts, colors: s.speeds.map((v) => speedColor(v)) };
      }),
    [results]
  );
  return (
    <group>
      {lines.map((l) => (
        <Line key={l.id} points={l.pts} vertexColors={l.colors} lineWidth={faint ? 1 : 1.4} transparent opacity={faint ? 0.3 : 0.8} />
      ))}
    </group>
  );
}

/**
 * Moving streaks: each is a short trail drawn between where an air parcel is
 * now and where it was a moment ago, so both the direction and the speed of
 * the air are visible. Parcels follow the CFD streamlines at their real speed
 * (×4 in the overview so the floor stays lively), coloured on the speed scale.
 */
function Streaks({ results, perLine, timeScale }: { results: FacilityResults; perLine: number; timeScale: number }) {
  const ref = useRef<THREE.LineSegments>(null);
  const trail = 0.7; // seconds of travel shown behind each parcel

  const { tracks, geometry } = useMemo(() => {
    const tracks: { pts: Float32Array; speeds: number[]; times: Float32Array; total: number; offset: number }[] = [];
    for (const s of results.streamlines) {
      const n = s.points.length / 3;
      if (n < 4) continue;
      const pts = Float32Array.from(s.points);
      const times = new Float32Array(n);
      for (let i = 1; i < n; i++) {
        const ds = Math.hypot(pts[i * 3] - pts[i * 3 - 3], pts[i * 3 + 1] - pts[i * 3 - 2], pts[i * 3 + 2] - pts[i * 3 - 1]);
        times[i] = times[i - 1] + ds / Math.max(0.02, (s.speeds[i] + s.speeds[i - 1]) / 2);
      }
      const total = Math.min(times[n - 1], 240);
      for (let k = 0; k < perLine; k++) tracks.push({ pts, speeds: s.speeds, times, total, offset: (k / perLine) * total });
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(tracks.length * 6), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(tracks.length * 6), 3));
    return { tracks, geometry: g };
  }, [results, perLine]);

  useFrame((state) => {
    // Through the ref: the memoised geometry itself must not be mutated.
    const g = ref.current?.geometry;
    if (!g) return;
    const pos = g.attributes.position.array as Float32Array;
    const col = g.attributes.color.array as Float32Array;
    const t = state.clock.elapsedTime * timeScale;

    const at = (tr: (typeof tracks)[number], time: number, out: number[]) => {
      const n = tr.times.length;
      const target = Math.max(0, Math.min(tr.total, time));
      let lo = 0;
      let hi = n - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (tr.times[mid] <= target) lo = mid;
        else hi = mid;
      }
      const span = tr.times[hi] - tr.times[lo];
      const w = span > 0 ? Math.min(1, (target - tr.times[lo]) / span) : 0;
      out[0] = tr.pts[lo * 3] * (1 - w) + tr.pts[hi * 3] * w;
      out[1] = tr.pts[lo * 3 + 1] * (1 - w) + tr.pts[hi * 3 + 1] * w;
      out[2] = tr.pts[lo * 3 + 2] * (1 - w) + tr.pts[hi * 3 + 2] * w;
      out[3] = tr.speeds[lo] * (1 - w) + tr.speeds[hi] * w;
    };
    const head = [0, 0, 0, 0];
    const tail = [0, 0, 0, 0];
    tracks.forEach((tr, i) => {
      const local = (t + tr.offset) % Math.max(tr.total, 1e-3);
      at(tr, local, head);
      at(tr, local - trail * timeScale, tail);
      pos.set([tail[0], tail[2], tail[1], head[0], head[2], head[1]], i * 6);
      const [r, g, b] = speedRgb(head[3]);
      col.set([r * 0.15, g * 0.15, b * 0.15, r, g, b], i * 6);
    });
    g.attributes.position.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
  });

  return (
    <lineSegments ref={ref} geometry={geometry}>
      <lineBasicMaterial vertexColors transparent opacity={0.95} />
    </lineSegments>
  );
}

/** Texture for a speed grid on the shared colour scale; solid cells transparent. */
function speedTexture(values: number[], nx: number, ny: number, flipY = false): THREE.DataTexture {
  const data = new Uint8Array(nx * ny * 4);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const v = values[i + nx * j];
      const row = flipY ? ny - 1 - j : j;
      const o = (i + nx * row) * 4;
      if (v < 0) continue;
      const [r, g, b] = speedRgb(v);
      data[o] = r * 255;
      data[o + 1] = g * 255;
      data[o + 2] = b * 255;
      data[o + 3] = 215;
    }
  }
  const tex = new THREE.DataTexture(data, nx, ny, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** Horizontal colour map of air speed at working height. */
function SpeedMaps({ slices }: { slices: SpeedSlice[] }) {
  const maps = useMemo(
    () =>
      slices.map((sl) => ({
        sl,
        // The floor plane's texture rows run opposite to plan y, hence the flip.
        tex: speedTexture(sl.speed, sl.nx, sl.ny, true),
      })),
    [slices]
  );
  return (
    <group>
      {maps.map(({ sl, tex }, i) => {
        const w = sl.nx * sl.hx;
        const d = sl.ny * sl.hy;
        // Later maps (room studies) sit a hair above the floor map.
        return (
          <mesh key={i} position={[sl.x0 + w / 2, sl.z + i * 0.004, sl.y0 + d / 2]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[w, d]} />
            <meshBasicMaterial map={tex} transparent side={THREE.DoubleSide} depthWrite={false} />
          </mesh>
        );
      })}
    </group>
  );
}

/** Vertical cut through a studied room: speed colours plus in-plane arrows. */
function Sections({ sections }: { sections: SpeedSection[] }) {
  const items = useMemo(
    () =>
      sections.map((sec) => {
        const tex = speedTexture(sec.speed, sec.nAlong, sec.nz);
        const pos: number[] = [];
        const col: number[] = [];
        const stride = Math.max(1, Math.round(0.3 / sec.hAlong));
        for (let k = 1; k < sec.nz; k += stride) {
          for (let a = 0; a < sec.nAlong; a += stride) {
            const n = a + sec.nAlong * k;
            if (sec.speed[n] < 0.02) continue;
            const s = Math.hypot(sec.along[n], sec.w[n]);
            if (s < 1e-6) continue;
            const L = 0.24 * Math.min(1, 0.4 + sec.speed[n] / 0.4);
            const da = (sec.along[n] / s) * L;
            const dz = (sec.w[n] / s) * L;
            const ca = sec.from + (a + 0.5) * sec.hAlong;
            const cz = (k + 0.5) * sec.hz;
            const tip = [ca + da, cz + dz];
            const segs = [
              [ca, cz, tip[0], tip[1]],
              [tip[0], tip[1], tip[0] - da * 0.35 - dz * 0.25, tip[1] - dz * 0.35 + da * 0.25],
              [tip[0], tip[1], tip[0] - da * 0.35 + dz * 0.25, tip[1] - dz * 0.35 - da * 0.25],
            ];
            for (const g of segs) {
              if (sec.axis === 'x') pos.push(g[0], g[1], sec.at + 0.01, g[2], g[3], sec.at + 0.01);
              else pos.push(sec.at + 0.01, g[1], g[0], sec.at + 0.01, g[3], g[2]);
              col.push(1, 1, 1, 1, 1, 1);
            }
          }
        }
        const arrows = new THREE.BufferGeometry();
        arrows.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        arrows.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
        return { sec, tex, arrows };
      }),
    [sections]
  );
  return (
    <group>
      {items.map(({ sec, tex, arrows }, i) => {
        const len = sec.nAlong * sec.hAlong;
        const h = sec.nz * sec.hz;
        const mid = sec.from + len / 2;
        return (
          <group key={i}>
            <mesh position={sec.axis === 'x' ? [mid, h / 2, sec.at] : [sec.at, h / 2, mid]} rotation={sec.axis === 'x' ? [0, 0, 0] : [0, -Math.PI / 2, 0]}>
              <planeGeometry args={[len, h]} />
              <meshBasicMaterial map={tex} transparent side={THREE.DoubleSide} depthWrite={false} />
            </mesh>
            <lineSegments geometry={arrows}>
              <lineBasicMaterial vertexColors transparent opacity={0.85} />
            </lineSegments>
          </group>
        );
      })}
    </group>
  );
}

function Vectors({ results }: { results: FacilityResults }) {
  const geometry = useMemo(() => {
    const pos: number[] = [];
    const col: number[] = [];
    const len = 0.32;
    for (const v of results.vectors) {
      if (v.m < 0.005) continue;
      const [x, y, z] = v.p;
      const [dx, dy, dz] = v.d;
      const l = len * Math.min(1, 0.35 + v.m / 0.3);
      const tip = [x + dx * l, y + dy * l, z + dz * l];
      const c = speedColor(v.m);
      // Shaft plus two head strokes, in plan; heads splay in the xy plane.
      const hx = -dx * 0.35 * l;
      const hy = -dy * 0.35 * l;
      const segs = [
        [x, y, z, tip[0], tip[1], tip[2]],
        [tip[0], tip[1], tip[2], tip[0] + hx - hy * 0.6, tip[1] + hy + hx * 0.6, tip[2]],
        [tip[0], tip[1], tip[2], tip[0] + hx + hy * 0.6, tip[1] + hy - hx * 0.6, tip[2]],
      ];
      for (const s of segs) {
        pos.push(s[0], s[2] + 0.02, s[1], s[3], s[5] + 0.02, s[4]);
        col.push(c.r, c.g, c.b, c.r, c.g, c.b);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    return g;
  }, [results]);
  return (
    <lineSegments geometry={geometry}>
      <lineBasicMaterial vertexColors />
    </lineSegments>
  );
}

function DeadZones({ results }: { results: FacilityResults }) {
  return (
    <group>
      {results.deadZones.map((z, i) => (
        <mesh key={i} position={[z.x, z.z, z.y]}>
          <sphereGeometry args={[Math.max(0.15, Math.cbrt(z.volume) * 0.55), 14, 14]} />
          <meshStandardMaterial color="#f43f5e" transparent opacity={0.28} depthWrite={false} />
        </mesh>
      ))}
    </group>
  );
}

// ============= Walk-through =============

/** Ceilings only matter from the inside; the overview looks down through them. */
function Ceilings({ facility }: { facility: Facility }) {
  return (
    <group>
      {facility.rooms.flatMap((room) =>
        room.rects.map((r, i) => (
          <mesh key={`${room.id}-c${i}`} position={[(r.x0 + r.x1) / 2, room.height, (r.y0 + r.y1) / 2]} rotation={[Math.PI / 2, 0, 0]}>
            <planeGeometry args={[r.x1 - r.x0, r.y1 - r.y0]} />
            <meshStandardMaterial color="#dbe3ec" side={THREE.DoubleSide} />
          </mesh>
        ))
      )}
    </group>
  );
}

/**
 * First-person walker: mouse-look through pointer lock, WASD / arrows to
 * move, Shift to run. Walls and shut doors block; movement slides along them.
 */
function TourRig({
  facility,
  walls,
  objects,
  network,
  tour,
  onPlayer,
  onLockChange,
}: {
  facility: Facility;
  walls: WallSegment[];
  objects: FacilityObject[];
  network: NetworkState;
  tour: TourRequest;
  onPlayer?: (pose: PlayerPose) => void;
  onLockChange?: (locked: boolean) => void;
}) {
  // Read the camera from the store where it is used: it is mutated every frame.
  const get = useThree((s) => s.get);
  const controls = useRef<PointerLockControlsImpl>(null);
  const keys = useRef(new Set<string>());
  const sinceReport = useRef(0);
  const scratch = useRef(new THREE.Vector3());

  const doorsOpen = useMemo(() => Object.fromEntries(network.doors.map((d) => [d.doorId, d.open])), [network]);
  const rects = useMemo(() => collisionRects(facility, walls, doorsOpen, objects), [facility, walls, doorsOpen, objects]);

  // Place the walker whenever a room is (re-)entered.
  useEffect(() => {
    const spawn = spawnFor(facility, tour.roomId);
    if (!spawn) return;
    const camera = get().camera;
    camera.position.set(spawn.x, EYE_HEIGHT, spawn.y);
    camera.quaternion.setFromEuler(new THREE.Euler(0, spawn.yaw, 0, 'YXZ'));
    const cam = camera as THREE.PerspectiveCamera;
    cam.fov = 72;
    cam.near = 0.05;
    cam.updateProjectionMatrix();
  }, [get, facility, tour.roomId, tour.nonce]);

  useEffect(() => {
    const pressed = keys.current;
    const down = (e: KeyboardEvent) => pressed.add(e.code);
    const up = (e: KeyboardEvent) => pressed.delete(e.code);
    const clear = () => pressed.clear();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', clear);
    };
  }, []);

  useFrame((state, dt) => {
    const camera = state.camera;
    const forward = scratch.current;
    camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();

    const k = keys.current;
    if (controls.current?.isLocked) {
      const f = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
      const r = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
      if (f !== 0 || r !== 0) {
        const step = (k.has('ShiftLeft') || k.has('ShiftRight') ? RUN_SPEED : WALK_SPEED) * Math.min(dt, 0.05);
        const len = Math.hypot(f, r);
        // Plan axes: forward (fx, fy) and right (-fy, fx).
        const dx = ((f * forward.x - r * forward.z) / len) * step;
        const dy = ((f * forward.z + r * forward.x) / len) * step;
        const x = camera.position.x;
        const y = camera.position.z;
        // Never trap the walker: if already overlapping (a door shut on them), let them move out.
        const stuck = blocked(facility, rects, x, y);
        if (stuck || !blocked(facility, rects, x + dx, y)) camera.position.x = x + dx;
        if (stuck || !blocked(facility, rects, camera.position.x, y + dy)) camera.position.z = y + dy;
      }
    }
    camera.position.y = EYE_HEIGHT;

    sinceReport.current += dt;
    if (sinceReport.current > 0.12) {
      sinceReport.current = 0;
      onPlayer?.({ x: camera.position.x, y: camera.position.z, fx: forward.x, fy: forward.z });
    }
  });

  // Any "walk" button asks for the mouse through a window event, so buttons
  // can come and go without losing their binding.
  useEffect(() => {
    const lock = () => controls.current?.lock();
    window.addEventListener(TOUR_LOCK_EVENT, lock);
    return () => window.removeEventListener(TOUR_LOCK_EVENT, lock);
  }, []);

  return (
    <PointerLockControls
      ref={controls}
      selector="#facility-tour-no-auto-lock"
      onLock={() => onLockChange?.(true)}
      onUnlock={() => onLockChange?.(false)}
    />
  );
}

/** Orbit view of the whole floor; resets the camera when coming back from a tour. */
function OverviewRig({
  cx,
  cy,
  enabled,
  focus,
}: {
  cx: number;
  cy: number;
  enabled: boolean;
  /** Frame one room (x, y centre and its size) instead of the whole floor */
  focus: { x: number; y: number; span: number } | null;
}) {
  const get = useThree((s) => s.get);
  const target: [number, number, number] = focus ? [focus.x, 1.2, focus.y] : [cx, 0, cy];
  useEffect(() => {
    const cam = get().camera as THREE.PerspectiveCamera;
    if (focus) {
      const d = Math.max(4, focus.span * 1.05);
      cam.position.set(focus.x + d * 0.55, 1.2 + d * 0.75, focus.y + d * 0.85);
    } else {
      cam.position.set(cx + 18, 30, cy + 26);
    }
    cam.fov = 45;
    cam.near = 0.05;
    cam.updateProjectionMatrix();
    cam.lookAt(target[0], target[1], target[2]);
    // Re-frame only when the framing itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [get, cx, cy, focus?.x, focus?.y, focus?.span]);
  return <OrbitControls target={target} enabled={enabled} enableDamping dampingFactor={0.08} maxPolarAngle={Math.PI / 2.05} />;
}

/**
 * While something is being dragged, a large invisible plane at the item's
 * height catches the pointer so the item follows the cursor.
 */
function DragPlane({
  height,
  onMove,
  onEnd,
}: {
  height: number;
  onMove: (x: number, y: number) => void;
  onEnd: () => void;
}) {
  return (
    <mesh
      position={[0, height, 0]}
      rotation={[-Math.PI / 2, 0, 0]}
      onPointerMove={(e) => {
        e.stopPropagation();
        onMove(e.point.x, e.point.z);
      }}
      onPointerUp={(e) => {
        e.stopPropagation();
        onEnd();
      }}
    >
      <planeGeometry args={[400, 400]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
    </mesh>
  );
}

// ============= Scene =============

export default function FacilityScene3D(props: Props) {
  const { facility, walls, terminals, network, colorMode, layers, results, tour } = props;
  // Frame the whole ground floor, context areas included.
  const all = [...facility.rooms, ...(facility.contextRooms ?? [])].flatMap((r) => r.rects);
  const minX = Math.min(...all.map((r) => r.x0));
  const maxX = Math.max(...all.map((r) => r.x1));
  const minY = Math.min(...all.map((r) => r.y0));
  const maxY = Math.max(...all.map((r) => r.y1));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const touring = Boolean(tour);
  const smoke = props.smoke ?? null;
  const focusRoom = smoke ? facility.rooms.find((r) => r.id === smoke.roomId) ?? null : null;
  const focus = useMemo(() => {
    if (!focusRoom) return null;
    const xs = focusRoom.rects.flatMap((r) => [r.x0, r.x1]);
    const ys = focusRoom.rects.flatMap((r) => [r.y0, r.y1]);
    const w = Math.max(...xs) - Math.min(...xs);
    const d = Math.max(...ys) - Math.min(...ys);
    return { x: (Math.max(...xs) + Math.min(...xs)) / 2, y: (Math.max(...ys) + Math.min(...ys)) / 2, span: Math.max(w, d) };
  }, [focusRoom]);
  // During a smoke test only the smoke, the operator and the air markers are
  // shown, so the story (in at the top, out at the risers) reads clearly.
  const quiet = smoke !== null;

  const [drag, setDrag] = useState<{ kind: 'object' | 'terminal'; id: string; height: number } | null>(null);
  const onDragStart: DragStart = (kind, id, height) => setDrag({ kind, id, height });
  const onDragMove = (x: number, y: number) => {
    if (!drag) return;
    if (drag.kind === 'object') {
      // Objects stay on the floor of a ventilated room.
      if (roomAt(facility, x, y)) props.onMoveObject(drag.id, x, y);
    } else props.onMoveTerminal(drag.id, x, y);
  };

  return (
    <Canvas camera={{ position: [cx + 18, 30, cy + 26], fov: 45, near: 0.1, far: 500 }} onPointerMissed={() => {
      if (touring) return;
      props.onSelectRoom(null);
      props.onSelectObject(null);
    }}>
      <color attach="background" args={['#0b1220']} />
      {tour ? (
        <TourRig
          facility={facility}
          walls={walls}
          objects={props.objects}
          network={network}
          tour={tour}
          onPlayer={props.onPlayer}
          onLockChange={props.onLockChange}
        />
      ) : (
        <OverviewRig cx={cx} cy={cy} enabled={!drag} focus={focus} />
      )}
      <ambientLight intensity={0.65} />
      <directionalLight position={[cx + 20, 40, cy - 10]} intensity={0.8} />
      <directionalLight position={[cx - 20, 25, cy + 30]} intensity={0.3} />

      {/* Slab */}
      <mesh position={[cx, -0.06, cy]}>
        <boxGeometry args={[maxX - minX + 1.2, 0.1, maxY - minY + 1.2]} />
        <meshStandardMaterial color="#1e293b" />
      </mesh>
      <gridHelper args={[80, 80, '#1e293b', '#152033']} position={[cx, -0.11, cy]} />

      {!touring && <ContextAreas facility={facility} walls={props.contextWalls} labels={layers.labels && !quiet} />}
      <Floors
        facility={facility}
        network={network}
        colorMode={colorMode}
        selectedRoom={props.selectedRoom}
        onSelectRoom={props.onSelectRoom}
        neutral={quiet}
      />
      <Walls
        facility={facility}
        walls={walls}
        cut={!touring && (layers.walls === 'cut' || props.editMode)}
        solid={touring}
        focusRoom={touring ? null : focusRoom?.id ?? null}
        network={network}
        onToggleDoor={props.onToggleDoor}
      />
      {touring && <Ceilings facility={facility} />}
      {(touring || layers.terminals || props.editMode) && (
        <Terminals
          terminals={terminals}
          editMode={props.editMode && !touring}
          onDragStart={onDragStart}
          neutral={quiet}
          selected={props.selectedTerminal ?? null}
          onSelect={props.onSelectTerminal ?? (() => undefined)}
        />
      )}
      <Objects
        objects={props.objects}
        editMode={props.editMode && !touring}
        selected={props.selectedObject}
        onSelect={props.onSelectObject}
        onDragStart={onDragStart}
        neutral={quiet}
      />
      {!touring && !quiet && layers.labels && <RoomLabels facility={facility} network={network} selectedRoom={props.selectedRoom} />}
      {layers.doorDp && !quiet && <DoorBadges facility={facility} network={network} occlude={touring} />}

      {/* Measurement slices are overview tools; inside a room they read as solid objects. */}
      {!quiet && !touring && layers.speedMap && props.slices.length > 0 && <SpeedMaps slices={props.slices} />}
      {!quiet && !touring && layers.section && props.sections.length > 0 && <Sections sections={props.sections} />}
      {/* Floor-wide lines and streaks are overview tools; inside a room the air paths tell the story. */}
      {!quiet && !touring && results && layers.streamlines && <Streamlines results={results} faint={layers.particles} />}
      {!quiet && !touring && results && layers.particles && <Streaks results={results} perLine={4} timeScale={4} />}
      {!quiet && layers.airPaths && props.airPaths && (
        <AirPaths3D
          paths={props.airPaths.paths}
          sources={props.airPaths.sources}
          sinks={props.airPaths.sinks}
          shares={props.airPaths.shares}
          labels={layers.labels || touring}
          occlude={touring}
        />
      )}
      {!quiet && results && layers.vectors && <Vectors results={results} />}
      {!quiet && results && layers.deadZones && <DeadZones results={results} />}
      {smoke && <SmokeTest3D setup={smoke} onStats={props.onSmokeStats ?? (() => undefined)} />}
      {/* Balls only when the air paths are off: the paths already show the air. */}
      {!smoke && props.ambientAir && layers.particles && !layers.airPaths && (
        <SmokeTest3D setup={props.ambientAir} onStats={() => undefined} />
      )}

      {drag && <DragPlane height={drag.height} onMove={onDragMove} onEnd={() => setDrag(null)} />}
    </Canvas>
  );
}
