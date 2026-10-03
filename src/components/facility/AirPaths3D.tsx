'use client';

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { AirPath, Sink, Source } from '@/lib/facility/smoke';

/** One muted colour per suction, so a path's colour says where its air leaves. */
export const SINK_COLORS = ['#60a5fa', '#f59e0b', '#34d399', '#f472b6', '#a78bfa', '#f87171', '#22d3ee', '#facc15'];
export const CIRCULATING_COLOR = '#94a3b8';

export const sinkColor = (index: number) => (index < 0 ? CIRCULATING_COLOR : SINK_COLORS[index % SINK_COLORS.length]);

const SPACING = 0.28; // m between chevrons along a tube

/** Chevrons on a faint band: tinted by the path colour, they point along the flow. */
function chevronTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillRect(0, 0, 64, 32);
    ctx.fillStyle = 'rgba(255,255,255,1)';
    ctx.beginPath();
    ctx.moveTo(18, 2);
    ctx.lineTo(42, 16);
    ctx.lineTo(18, 30);
    ctx.lineTo(28, 16);
    ctx.closePath();
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/**
 * Thick air paths from each supply terminal to the suction its air leaves
 * through, with chevrons moving at the air's own speed, and labels on the
 * supply and suction points.
 */
export default function AirPaths3D({
  paths,
  sources,
  sinks,
  shares,
  labels,
  occlude,
}: {
  paths: AirPath[];
  sources: Source[];
  sinks: Sink[];
  /** Share of the room's air leaving through each sink */
  shares: number[];
  labels: boolean;
  occlude: boolean;
}) {
  const meshes = useRef<(THREE.Mesh | null)[]>([]);

  const tubes = useMemo(() => {
    const base = chevronTexture();
    return paths.map((p) => {
      // Keep every 3rd point: the tube stays smooth and light.
      const pts: THREE.Vector3[] = [];
      const n = p.points.length / 3;
      for (let i = 0; i < n; i += 3) pts.push(new THREE.Vector3(p.points[i * 3], p.points[i * 3 + 2], p.points[i * 3 + 1]));
      const last = n - 1;
      pts.push(new THREE.Vector3(p.points[last * 3], p.points[last * 3 + 2], p.points[last * 3 + 1]));
      if (pts.length < 2) return null;
      const curve = new THREE.CatmullRomCurve3(pts);
      const length = curve.getLength();
      const geometry = new THREE.TubeGeometry(curve, Math.min(600, Math.max(8, Math.round(length / 0.05))), 0.02, 8, false);
      const map = base.clone();
      map.needsUpdate = true;
      map.repeat.set(Math.max(1, length / SPACING), 1);
      const material = new THREE.MeshBasicMaterial({ color: sinkColor(p.sink), map, transparent: true, opacity: 0.95, depthWrite: false });
      return { geometry, material, speed: Math.max(0.03, p.meanSpeed) };
    });
  }, [paths]);

  useFrame((_, delta) => {
    tubes.forEach((t, i) => {
      const mesh = meshes.current[i];
      if (!t || !mesh) return;
      // Chevrons travel along the tube at the air's mean speed on that path.
      const map = (mesh.material as THREE.MeshBasicMaterial).map;
      if (map) map.offset.x -= (t.speed * Math.min(delta, 0.05)) / SPACING;
    });
  });

  return (
    <group>
      {tubes.map((t, i) =>
        t ? <mesh key={i} ref={(el) => void (meshes.current[i] = el)} geometry={t.geometry} material={t.material} /> : null
      )}

      {/* Suction points: coloured frame on the grille plus its share of the air */}
      {sinks.map((s, i) => {
        if ((shares[i] ?? 0) <= 0.005) return null;
        const color = sinkColor(i);
        return (
          <group key={s.id}>
            <mesh position={[s.face[0], s.face[2], s.face[1]]}>
              <sphereGeometry args={[0.09, 16, 16]} />
              <meshBasicMaterial color={color} transparent opacity={0.55} />
            </mesh>
            {labels && (
              <Html position={[s.face[0], s.face[2] + 0.35, s.face[1]]} center distanceFactor={occlude ? undefined : 6} occlude={occlude} zIndexRange={[6, 0]}>
                <div className="pointer-events-none select-none whitespace-nowrap rounded-md border bg-slate-950/85 px-2 py-1 text-[11px]" style={{ borderColor: color }}>
                  <div className="font-semibold" style={{ color }}>
                    ⬇ Suction · {s.kind === 'door' ? s.label : s.label.replace(/^Riser R\d,?\s*/, 'riser, ')}
                  </div>
                  <div className="text-slate-300">{Math.round((shares[i] ?? 0) * 100)} % of the room&apos;s air leaves here</div>
                </div>
              </Html>
            )}
          </group>
        );
      })}

      {/* Supply points */}
      {labels &&
        sources.map((s) => (
          <Html key={s.id} position={[s.x, s.z - 0.25, s.y]} center distanceFactor={occlude ? undefined : 6} occlude={occlude} zIndexRange={[6, 0]}>
            <div className="pointer-events-none select-none whitespace-nowrap rounded-md border border-slate-500 bg-slate-950/85 px-2 py-1 text-[11px] text-slate-200">
              <span className="font-semibold">⬇ Clean air in</span> · supply terminal
            </div>
          </Html>
        ))}
    </group>
  );
}
