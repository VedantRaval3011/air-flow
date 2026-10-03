'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { VelocityField } from '@/lib/facility/types';
import {
  OperatorSpot,
  ParcelPool,
  ParcelState,
  Sink,
  SmokeCounters,
  Source,
  intoAir,
  newCounters,
  stepParcels,
} from '@/lib/facility/smoke';

/** One cycle of the operator's routine (s). */
export const ROUTINE_SECONDS = 18;

/**
 * Steps of a smoke study, in the order they happen. The panel highlights the
 * current one; `phaseAt` maps routine time to a step.
 */
export const SMOKE_STEPS = [
  'Clean air enters from the HEPA / diffusers at the ceiling',
  'Operator raises the fogger wand into the supply air',
  'Smoke is released and joins the airflow',
  'The airflow carries the smoke down and across the room',
  'Smoke is drawn into the low-level risers and leaves the room',
] as const;

export interface SmokeStats {
  /** Seconds since the test started */
  t: number;
  step: number;
  /** The operator has finished releasing smoke */
  releaseEnded: boolean;
  /** 95 % of the smoke has left the room (or the time limit was reached) */
  done: boolean;
  /** Seconds after the release ended until 95 % of the smoke had left */
  clearance95: number | null;
  /**
   * 100:1 recovery time (ISO 14644-3), extrapolated from the 95 % clearance
   * assuming exponential dilution: t99 = t95 · ln 100 / ln 20.
   */
  recovery100: number | null;
  /** Share of the released smoke that has left the room so far (0–1) */
  outFraction: number;
  /** Estimated test time left until 95 % has left (s at 1×), from the dilution so far */
  eta: number | null;
  /** Ended with the "End test now" button */
  stoppedEarly: boolean;
  smokeReleased: number;
  smokeCaptured: number;
  smokeInRoom: number;
  capturedBySink: Record<string, number>;
  tracersReleased: number;
  tracersCaptured: number;
  /** Median time from release to leaving the room (s), smoke parcels */
  medianTransit: number | null;
}

export interface SmokeTestSetup {
  /**
   * 'smoke-test': the operator releases smoke once, the test runs until the
   * room is clear, then stops. 'air': just the supply air as moving balls,
   * continuously (used while walking through a room).
   */
  mode: 'smoke-test' | 'air';
  field: VelocityField;
  sources: Source[];
  sinks: Sink[];
  operator: OperatorSpot;
  roomHeight: number;
  /** Simulation speed multiplier (1 = real time) */
  speed: number;
  /** Changes to restart the test */
  nonce: number;
  /** Ask a running smoke test to finish now */
  endNow?: boolean;
}

const SMOKE_POOL = 2600;
const TRACER_POOL = 2500;
const SMOKE_RATE = 110; // puffs / s while the fogger runs
// Balls / s from all supply terminals together. With a room's air-change
// time of 1–2.5 min this keeps well under the pool, so no ball is recycled.
const TRACER_RATE = 10;
// Parcels only leave through the room's suction; these are safety limits.
const SMOKE_LIFE = 900; // s
const TRACER_LIFE = 900; // s
/** The operator releases smoke for one pass of the routine. */
const RELEASE_END = 16.8; // s
/** A test that has not cleared by then is stopped and reported as such. */
const TEST_LIMIT = 10 * 60; // s
/** The test is complete once this share of the released smoke has left. */
const CLEARED = 0.95;

const smooth = (a: number, b: number, t: number) => {
  const x = Math.max(0, Math.min(1, (t - a) / (b - a)));
  return x * x * (3 - 2 * x);
};

/**
 * Operator routine over one cycle: returns arm angles and whether the fogger
 * is running. Angles are radians; shoulder pitch 0 = arm hanging, -π/2 =
 * straight forward, more negative = raised.
 */
function routine(t: number) {
  // One pass only; afterwards the operator stands with the wand lowered.
  const c = Math.min(t, ROUTINE_SECONDS);
  const raise = smooth(0.5, 3, c) * (1 - smooth(9, 11, c));
  const working = smooth(9, 11, c) * (1 - smooth(16.5, 17.8, c));
  const pitch = -0.25 + raise * -2.05 + working * -1.15;
  const sweep = raise * 0.3 * Math.sin(c * 1.3) + working * 0.45 * Math.sin((c - 11) * 0.9);
  const elbow = -0.25 - working * 0.35;
  const fogging = c > 2.6 && c < RELEASE_END;
  let step = 1;
  if (c < 0.8) step = 0;
  else if (c < 3) step = 1;
  else if (c < 7) step = 2;
  else step = 3;
  return { pitch, sweep, elbow, fogging, step, lean: raise * 0.06 };
}

/**
 * Time left until 95 % of the smoke has left, assuming the smoke still in the
 * room keeps diluting at the rate seen since the release stopped.
 */
function estimateEta(t: number, released: number, out: number): number | null {
  // The first smoke out takes the shortest routes; wait for the bulk before estimating.
  if (t < RELEASE_END + 20 || released === 0) return null;
  const remaining = 1 - out / released;
  if (remaining <= 1 - CLEARED) return 0;
  if (remaining >= 0.999) return null;
  const tau = (t - RELEASE_END) / Math.log(1 / remaining);
  return Math.max(0, tau * Math.log(1 / (1 - CLEARED)) - (t - RELEASE_END));
}

/** A gowned cleanroom operator holding a fogger wand; exposes the wand tip. */
function Operator({ spot, tipRef, clock }: { spot: OperatorSpot; tipRef: React.RefObject<THREE.Object3D | null>; clock: React.RefObject<number> }) {
  const shoulderR = useRef<THREE.Group>(null);
  const elbowR = useRef<THREE.Group>(null);
  const shoulderL = useRef<THREE.Group>(null);
  const torso = useRef<THREE.Group>(null);
  const head = useRef<THREE.Group>(null);

  useFrame(() => {
    const r = routine(clock.current ?? 0);
    if (shoulderR.current) shoulderR.current.rotation.set(r.pitch, r.sweep, 0, 'YXZ');
    if (elbowR.current) elbowR.current.rotation.set(r.elbow, 0, 0);
    if (shoulderL.current) shoulderL.current.rotation.set(-0.55 + 0.05 * Math.sin((clock.current ?? 0) * 0.8), 0, 0.12);
    if (torso.current) torso.current.rotation.set(r.lean, r.sweep * 0.25, 0);
    if (head.current) head.current.rotation.set(Math.max(-0.5, r.pitch * 0.28 + 0.1), r.sweep * 0.6, 0);
  });

  const suit = '#f1f5f9';
  const glove = '#93a4b8';
  return (
    <group position={[spot.x, 0, spot.y]} rotation={[0, spot.yaw, 0]}>
      {/* Legs and overshoes */}
      {[-0.1, 0.1].map((x) => (
        <group key={x}>
          <mesh position={[x, 0.42, 0]}>
            <cylinderGeometry args={[0.075, 0.065, 0.84, 12]} />
            <meshStandardMaterial color={suit} roughness={0.9} />
          </mesh>
          <mesh position={[x, 0.04, 0.03]}>
            <boxGeometry args={[0.11, 0.08, 0.26]} />
            <meshStandardMaterial color="#cbd5e1" roughness={0.9} />
          </mesh>
        </group>
      ))}
      <group ref={torso} position={[0, 0.86, 0]}>
        <mesh position={[0, 0.32, 0]}>
          <cylinderGeometry args={[0.17, 0.15, 0.64, 16]} />
          <meshStandardMaterial color={suit} roughness={0.9} />
        </mesh>
        {/* Hooded head with mask */}
        <group ref={head} position={[0, 0.78, 0]}>
          <mesh>
            <sphereGeometry args={[0.12, 16, 16]} />
            <meshStandardMaterial color={suit} roughness={0.9} />
          </mesh>
          <mesh position={[0, -0.02, 0.085]}>
            <boxGeometry args={[0.13, 0.07, 0.06]} />
            <meshStandardMaterial color="#dbe4ee" roughness={0.8} />
          </mesh>
          <mesh position={[0, 0.04, 0.1]}>
            <boxGeometry args={[0.14, 0.035, 0.03]} />
            <meshStandardMaterial color="#334155" roughness={0.3} />
          </mesh>
        </group>
        {/* Right arm: holds the fogger wand */}
        <group ref={shoulderR} position={[0.22, 0.58, 0]}>
          <mesh position={[0, -0.15, 0]}>
            <cylinderGeometry args={[0.05, 0.045, 0.3, 10]} />
            <meshStandardMaterial color={suit} roughness={0.9} />
          </mesh>
          <group ref={elbowR} position={[0, -0.3, 0]}>
            <mesh position={[0, -0.14, 0]}>
              <cylinderGeometry args={[0.045, 0.04, 0.28, 10]} />
              <meshStandardMaterial color={suit} roughness={0.9} />
            </mesh>
            <mesh position={[0, -0.3, 0]}>
              <sphereGeometry args={[0.045, 10, 10]} />
              <meshStandardMaterial color={glove} roughness={0.6} />
            </mesh>
            {/* Wand: continues the forearm, nozzle at the end */}
            <group position={[0, -0.3, 0]} rotation={[-0.35, 0, 0]}>
              <mesh position={[0, -0.36, 0]}>
                <cylinderGeometry args={[0.009, 0.009, 0.72, 8]} />
                <meshStandardMaterial color="#64748b" metalness={0.5} roughness={0.4} />
              </mesh>
              <mesh position={[0, -0.73, 0]}>
                <cylinderGeometry args={[0.018, 0.012, 0.05, 8]} />
                <meshStandardMaterial color="#475569" />
              </mesh>
              <object3D ref={tipRef} position={[0, -0.77, 0]} />
            </group>
          </group>
        </group>
        {/* Left arm: carries the fog generator */}
        <group ref={shoulderL} position={[-0.22, 0.58, 0]}>
          <mesh position={[0, -0.15, 0]}>
            <cylinderGeometry args={[0.05, 0.045, 0.3, 10]} />
            <meshStandardMaterial color={suit} roughness={0.9} />
          </mesh>
          <group position={[0, -0.3, 0]} rotation={[-0.9, 0, 0]}>
            <mesh position={[0, -0.14, 0]}>
              <cylinderGeometry args={[0.045, 0.04, 0.28, 10]} />
              <meshStandardMaterial color={suit} roughness={0.9} />
            </mesh>
            <mesh position={[0, -0.32, 0.02]}>
              <boxGeometry args={[0.12, 0.16, 0.2]} />
              <meshStandardMaterial color="#e2e8f0" roughness={0.5} />
            </mesh>
          </group>
        </group>
      </group>
    </group>
  );
}

/** Soft round sprites with per-puff size and opacity. */
const smokeMaterial = () =>
  new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uScale: { value: 400 } },
    vertexShader: `
      attribute float aSize;
      attribute float aAlpha;
      uniform float uScale;
      varying float vAlpha;
      void main() {
        vAlpha = aAlpha;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * uScale / max(0.05, -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying float vAlpha;
      void main() {
        float r = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.05, r) * vAlpha;
        if (a < 0.004) discard;
        gl_FragColor = vec4(0.94, 0.95, 0.96, a);
      }`,
  });

/**
 * Chevrons that drift slowly in the direction air moves: down out of each
 * supply face, into each extract grille. Neutral greys, no glow.
 */
function FlowMarkers({ sources, sinks, clock }: { sources: Source[]; sinks: Sink[]; clock: React.RefObject<number> }) {
  const refs = useRef<(THREE.Group | null)[]>([]);
  const markers = useMemo(() => {
    const list: { origin: THREE.Vector3; dir: THREE.Vector3; color: string; phase: number }[] = [];
    for (const s of sources) {
      for (let k = 0; k < 3; k++) {
        list.push({ origin: new THREE.Vector3(s.x, s.z - 0.05, s.y), dir: new THREE.Vector3(0, -1, 0), color: '#cbd5e1', phase: k / 3 });
      }
    }
    for (const s of sinks) {
      const dir = new THREE.Vector3(s.pull[0], s.pull[2], s.pull[1]).normalize();
      const face = new THREE.Vector3(s.face[0], s.face[2], s.face[1]);
      for (let k = 0; k < 3; k++) {
        list.push({ origin: face.clone().addScaledVector(dir, -0.45), dir, color: '#64748b', phase: k / 3 });
      }
    }
    return list;
  }, [sources, sinks]);

  useFrame(() => {
    const t = clock.current ?? 0;
    markers.forEach((m, i) => {
      const g = refs.current[i];
      if (!g) return;
      const f = (t * 0.45 + m.phase) % 1;
      g.position.copy(m.origin).addScaledVector(m.dir, f * 0.42);
      g.scale.setScalar(0.6 + 0.4 * Math.sin(f * Math.PI));
    });
  });

  return (
    <group>
      {markers.map((m, i) => {
        // Cone points along +y by default; turn it to the flow direction.
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), m.dir);
        return (
          <group key={i} ref={(el) => void (refs.current[i] = el)}>
            <mesh quaternion={q}>
              <coneGeometry args={[0.045, 0.1, 10]} />
              <meshStandardMaterial color={m.color} transparent opacity={0.75} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

interface Sim {
  smoke: ParcelPool;
  tracers: ParcelPool;
  smokeCounters: SmokeCounters;
  tracerCounters: SmokeCounters;
  t: number;
  smokeDebt: number;
  tracerDebt: number;
  lastReport: number;
  /** Furthest step of the sequence reached so far */
  maxStep: number;
  clearance95: number | null;
  done: boolean;
  stoppedEarly: boolean;
  /** Real seconds since the test finished; the room is cleared after a short fade */
  fade: number;
  cleared: boolean;
}

/**
 * The smoke study itself. Smoke leaves the operator's wand, tracer balls leave
 * the supply faces, and both are carried by the room's CFD flow into the
 * extract grilles (see lib/facility/smoke for the physics).
 */
export default function SmokeTest3D({ setup, onStats }: { setup: SmokeTestSetup; onStats: (s: SmokeStats) => void }) {
  const tipRef = useRef<THREE.Object3D>(null);
  const clock = useRef(0);
  const sim = useRef<Sim | null>(null);
  const pointsRef = useRef<THREE.Points>(null);
  const ballsRef = useRef<THREE.InstancedMesh>(null);
  const tip = useRef(new THREE.Vector3());
  const matrix = useRef(new THREE.Matrix4());

  const material = useMemo(() => smokeMaterial(), []);
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SMOKE_POOL * 3), 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(SMOKE_POOL), 1));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(SMOKE_POOL), 1));
    return g;
  }, []);

  // A new test (or a new room) starts from an empty room.
  useEffect(() => {
    sim.current = {
      smoke: new ParcelPool(SMOKE_POOL),
      tracers: new ParcelPool(TRACER_POOL),
      smokeCounters: newCounters(),
      tracerCounters: newCounters(),
      t: 0,
      smokeDebt: 0,
      tracerDebt: 0,
      lastReport: 0,
      maxStep: 0,
      clearance95: null,
      done: false,
      stoppedEarly: false,
      fade: 0,
      cleared: false,
    };
    clock.current = 0;
  }, [setup.nonce, setup.field]);

  useFrame((state, delta) => {
    const s = sim.current;
    if (!s) return;
    const smokeTest = setup.mode === 'smoke-test';
    // A finished test fades its smoke and balls out over two seconds, then the
    // room is emptied and nothing moves any more.
    if (s.cleared) return;
    if (s.done) s.fade += Math.min(delta, 0.1);
    const fadeLeft = s.done ? Math.max(0, 1 - s.fade / 2) : 1;
    if (s.done && fadeLeft === 0) {
      s.smoke.clear();
      s.tracers.clear();
      s.cleared = true;
      const pts = pointsRef.current;
      if (pts) {
        const alpha = pts.geometry.getAttribute('aAlpha') as THREE.BufferAttribute;
        for (let i = 0; i < alpha.count; i++) alpha.setX(i, 0);
        alpha.needsUpdate = true;
      }
      if (ballsRef.current) ballsRef.current.count = 0;
      return;
    }
    const dt = Math.min(delta, 0.05) * setup.speed;
    s.t += dt;
    clock.current = s.t;
    const { field, sources, sinks, roomHeight } = setup;
    const r = routine(s.t);

    // --- emit ---
    // Balls only in the plain air view; a smoke test shows just the smoke.
    s.tracerDebt += smokeTest ? 0 : TRACER_RATE * dt * 0.4;
    while (s.tracerDebt >= 1) {
      s.tracerDebt -= 1;
      let pick = Math.random();
      let src = sources[0];
      for (const q of sources) {
        pick -= q.weight;
        if (pick <= 0) {
          src = q;
          break;
        }
      }
      if (!src) break;
      const x = src.x + (Math.random() * 2 - 1) * src.hx * 0.9;
      const y = src.y + (Math.random() * 2 - 1) * src.hy * 0.9;
      if (s.tracers.spawn(x, y, intoAir(field, x, y, src.z), TRACER_LIFE) >= 0) s.tracerCounters.released++;
    }
    if (smokeTest && r.fogging && tipRef.current) {
      tipRef.current.getWorldPosition(tip.current);
      s.smokeDebt += SMOKE_RATE * dt;
      while (s.smokeDebt >= 1) {
        s.smokeDebt -= 1;
        const puff = s.smoke.spawn(
          tip.current.x + (Math.random() - 0.5) * 0.03,
          tip.current.z + (Math.random() - 0.5) * 0.03,
          tip.current.y + (Math.random() - 0.5) * 0.03,
          SMOKE_LIFE
        );
        if (puff >= 0) s.smokeCounters.released++;
      }
    }

    // --- move ---
    stepParcels(s.smoke, dt, field, sinks, { height: roomHeight }, s.smokeCounters);
    stepParcels(s.tracers, dt, field, sinks, { height: roomHeight }, s.tracerCounters);

    // --- draw smoke (through the ref: the memoised objects stay untouched) ---
    const pts = pointsRef.current;
    if (!pts) return;
    const cam = state.camera as THREE.PerspectiveCamera;
    (pts.material as THREE.ShaderMaterial).uniforms.uScale.value =
      state.size.height / (2 * Math.tan(((cam.fov ?? 50) * Math.PI) / 360));
    const pos = pts.geometry.getAttribute('position') as THREE.BufferAttribute;
    const size = pts.geometry.getAttribute('aSize') as THREE.BufferAttribute;
    const alpha = pts.geometry.getAttribute('aAlpha') as THREE.BufferAttribute;
    const P = s.smoke;
    let inRoom = 0;
    for (let i = 0; i < P.n; i++) {
      const st = P.state[i];
      if (st === ParcelState.Free) {
        alpha.setX(i, 0);
        continue;
      }
      if (st === ParcelState.Moving) inRoom++;
      pos.setXYZ(i, P.pos[i * 3], P.pos[i * 3 + 2], P.pos[i * 3 + 1]);
      const age = P.age[i];
      // Puffs grow as they mix into the room air and thin out with age.
      size.setX(i, 0.07 + 0.3 * Math.min(1, Math.sqrt(age / 8)));
      const fadeIn = Math.min(1, age / 0.25);
      const fadeOut = Math.max(0, 1 - age / P.life[i]);
      const capture = st === ParcelState.Captured ? Math.max(0, 1 - P.exitT[i] / 0.45) : 1;
      alpha.setX(i, 0.3 * fadeIn * Math.sqrt(fadeOut) * capture * fadeLeft);
    }
    pos.needsUpdate = true;
    size.needsUpdate = true;
    alpha.needsUpdate = true;

    // --- draw tracer balls ---
    const balls = ballsRef.current;
    if (balls) {
      const T = s.tracers;
      let n = 0;
      for (let i = 0; i < T.n; i++) {
        const st = T.state[i];
        if (st === ParcelState.Free) continue;
        const k =
          (st === ParcelState.Captured ? Math.max(0.05, 1 - T.exitT[i] / 0.45) : Math.min(1, T.age[i] / 0.3)) *
          Math.max(0.01, fadeLeft);
        matrix.current.makeScale(k, k, k).setPosition(T.pos[i * 3], T.pos[i * 3 + 2], T.pos[i * 3 + 1]);
        balls.setMatrixAt(n++, matrix.current);
      }
      balls.count = n;
      balls.instanceMatrix.needsUpdate = true;
    }

    // --- end of test: every puff has left through the suction ---
    const releaseEnded = s.t >= RELEASE_END;
    let finishing = false;
    if (smokeTest && releaseEnded && !s.done) {
      const out = Object.values(s.smokeCounters.captured).reduce((a, b) => a + b, 0);
      const released = s.smokeCounters.released;
      if (released > 0 && out >= CLEARED * released) s.clearance95 = s.t - RELEASE_END;
      if (s.clearance95 !== null || s.t > TEST_LIMIT) {
        s.done = true;
        finishing = true;
      }
    }
    if (smokeTest && setup.endNow && !s.done) {
      s.done = true;
      s.stoppedEarly = true;
      finishing = true;
    }

    // --- report (a completed test keeps its final figures) ---
    if (smokeTest && (finishing || (!s.done && s.t - s.lastReport > 0.25))) {
      s.lastReport = s.t;
      const captured = Object.values(s.smokeCounters.captured).reduce((a, b) => a + b, 0);
      // The sequence only moves forward: the last step is reached once smoke
      // released by the operator has actually left through the suction.
      s.maxStep = Math.max(s.maxStep, s.t < ROUTINE_SECONDS ? r.step : 3, captured > 0 && s.maxStep >= 3 ? 4 : 0);
      const res = s.smokeCounters.residence;
      const sorted = res.length ? [...res].sort((a, b) => a - b) : [];
      onStats({
        t: s.t,
        step: s.done ? SMOKE_STEPS.length : s.maxStep,
        releaseEnded,
        done: s.done,
        clearance95: s.clearance95,
        recovery100: s.clearance95 !== null ? (s.clearance95 * Math.log(100)) / Math.log(20) : null,
        outFraction: s.smokeCounters.released > 0 ? captured / s.smokeCounters.released : 0,
        eta: estimateEta(s.t, s.smokeCounters.released, captured),
        stoppedEarly: s.stoppedEarly,
        smokeReleased: s.smokeCounters.released,
        smokeCaptured: captured,
        smokeInRoom: inRoom,
        capturedBySink: { ...s.smokeCounters.captured },
        tracersReleased: s.tracerCounters.released,
        tracersCaptured: Object.values(s.tracerCounters.captured).reduce((a, b) => a + b, 0),
        medianTransit: sorted.length ? sorted[sorted.length >> 1] : null,
      });
    }
  });

  return (
    <group>
      {setup.mode === 'smoke-test' && <Operator spot={setup.operator} tipRef={tipRef} clock={clock} />}
      {setup.mode === 'smoke-test' && <FlowMarkers sources={setup.sources} sinks={setup.sinks} clock={clock} />}
      <points ref={pointsRef} geometry={geometry} material={material} frustumCulled={false} />
      <instancedMesh ref={ballsRef} args={[undefined, undefined, TRACER_POOL]} frustumCulled={false}>
        <sphereGeometry args={[0.022, 10, 10]} />
        <meshStandardMaterial color="#e2e8f0" roughness={0.5} />
      </instancedMesh>
    </group>
  );
}
