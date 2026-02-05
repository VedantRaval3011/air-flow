'use client';

import { useMemo, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, PerspectiveCamera, Line } from '@react-three/drei';
import * as THREE from 'three';
import { IVisualizationData, IStreamline, IVelocityVector, IDeadZone } from '@/types';

interface AirflowViewer3DProps {
    data: IVisualizationData;
    showStreamlines: boolean;
    showVectors: boolean;
    showDeadZones: boolean;
}

function velocityToColor(velocity: number, max: number): THREE.Color {
    const t = Math.min(velocity / max, 1);
    // Blue -> Cyan -> Green -> Yellow -> Red
    if (t < 0.25) {
        return new THREE.Color().lerpColors(
            new THREE.Color('#0000ff'),
            new THREE.Color('#00ffff'),
            t / 0.25
        );
    } else if (t < 0.5) {
        return new THREE.Color().lerpColors(
            new THREE.Color('#00ffff'),
            new THREE.Color('#00ff00'),
            (t - 0.25) / 0.25
        );
    } else if (t < 0.75) {
        return new THREE.Color().lerpColors(
            new THREE.Color('#00ff00'),
            new THREE.Color('#ffff00'),
            (t - 0.5) / 0.25
        );
    } else {
        return new THREE.Color().lerpColors(
            new THREE.Color('#ffff00'),
            new THREE.Color('#ff0000'),
            (t - 0.75) / 0.25
        );
    }
}

function Streamlines({ streamlines, maxVelocity }: { streamlines: IStreamline[]; maxVelocity: number }) {
    return (
        <group>
            {streamlines.map((streamline) => {
                if (streamline.points.length < 2) return null;

                const points = streamline.points.map(p => new THREE.Vector3(p.x, p.z, p.y));
                const colors = streamline.velocities.map(v => velocityToColor(v, maxVelocity));

                return (
                    <Line
                        key={streamline.id}
                        points={points}
                        vertexColors={colors}
                        lineWidth={2}
                    />
                );
            })}
        </group>
    );
}

function VelocityVectors({ vectors, maxVelocity }: { vectors: IVelocityVector[]; maxVelocity: number }) {
    // Sample every nth vector to avoid overwhelming the scene
    const sampledVectors = useMemo(() => {
        const step = Math.max(1, Math.floor(vectors.length / 500));
        return vectors.filter((_, i) => i % step === 0);
    }, [vectors]);

    return (
        <group>
            {sampledVectors.map((vec, i) => {
                const color = velocityToColor(vec.magnitude, maxVelocity);
                const scale = Math.min(vec.magnitude / maxVelocity * 0.5, 0.3);

                // Create arrow direction
                const dir = new THREE.Vector3(vec.direction.x, vec.direction.z, vec.direction.y).normalize();

                return (
                    <group key={i} position={[vec.position.x, vec.position.z, vec.position.y]}>
                        <arrowHelper
                            args={[
                                dir,
                                new THREE.Vector3(0, 0, 0),
                                scale,
                                color.getHex(),
                                scale * 0.3,
                                scale * 0.15
                            ]}
                        />
                    </group>
                );
            })}
        </group>
    );
}

function DeadZones({ zones }: { zones: IDeadZone[] }) {
    const ref = useRef<THREE.Group>(null);

    useFrame((state) => {
        if (ref.current) {
            ref.current.children.forEach((child) => {
                if (child instanceof THREE.Mesh) {
                    child.material.opacity = 0.3 + Math.sin(state.clock.elapsedTime * 2) * 0.1;
                }
            });
        }
    });

    return (
        <group ref={ref}>
            {zones.map((zone, i) => (
                <mesh key={i} position={[zone.position.x, zone.position.z, zone.position.y]}>
                    <sphereGeometry args={[Math.cbrt(zone.volume) / 2, 16, 16]} />
                    <meshStandardMaterial
                        color="#ef4444"
                        transparent
                        opacity={0.4}
                        side={THREE.DoubleSide}
                    />
                </mesh>
            ))}
        </group>
    );
}

function AnimatedParticles({ streamlines }: { streamlines: IStreamline[] }) {
    const particlesRef = useRef<THREE.Points>(null);

    // Create particle positions along streamlines
    const { positions, streamIndices } = useMemo(() => {
        const pos: number[] = [];
        const indices: number[] = [];

        streamlines.forEach((sl, slIdx) => {
            // Add a few particles per streamline
            for (let i = 0; i < 5; i++) {
                const pointIdx = Math.floor(Math.random() * sl.points.length);
                const point = sl.points[pointIdx];
                pos.push(point.x, point.z, point.y);
                indices.push(slIdx);
            }
        });

        return {
            positions: new Float32Array(pos),
            streamIndices: indices
        };
    }, [streamlines]);

    useFrame((state) => {
        if (particlesRef.current && streamlines.length > 0) {
            const positions = particlesRef.current.geometry.attributes.position.array as Float32Array;

            streamIndices.forEach((slIdx, i) => {
                const sl = streamlines[slIdx];
                if (sl.points.length > 0) {
                    // Move particle along streamline
                    const t = ((state.clock.elapsedTime * 0.5 + i * 0.3) % 1);
                    const idx = Math.floor(t * (sl.points.length - 1));
                    const point = sl.points[idx];

                    positions[i * 3] = point.x;
                    positions[i * 3 + 1] = point.z;
                    positions[i * 3 + 2] = point.y;
                }
            });

            particlesRef.current.geometry.attributes.position.needsUpdate = true;
        }
    });

    return (
        <points ref={particlesRef}>
            <bufferGeometry>
                <bufferAttribute
                    attach="attributes-position"
                    count={positions.length / 3}
                    array={positions}
                    itemSize={3}
                />
            </bufferGeometry>
            <pointsMaterial size={0.08} color="#00ffff" transparent opacity={0.8} />
        </points>
    );
}

export default function AirflowViewer3D({
    data,
    showStreamlines,
    showVectors,
    showDeadZones,
}: AirflowViewer3DProps) {
    const maxVelocity = data.colorRange.max || 3;

    // Estimate room size from data
    const bounds = useMemo(() => {
        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;
        let minZ = Infinity, maxZ = -Infinity;

        data.streamlines.forEach(sl => {
            sl.points.forEach(p => {
                minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
                minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
                minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
            });
        });

        data.velocityVectors.forEach(v => {
            minX = Math.min(minX, v.position.x); maxX = Math.max(maxX, v.position.x);
            minY = Math.min(minY, v.position.y); maxY = Math.max(maxY, v.position.y);
            minZ = Math.min(minZ, v.position.z); maxZ = Math.max(maxZ, v.position.z);
        });

        // Default bounds if no data
        if (!isFinite(minX)) {
            return { center: [5, 1.5, 4], size: [10, 3, 8] };
        }

        return {
            center: [(minX + maxX) / 2, (minZ + maxZ) / 2, (minY + maxY) / 2],
            size: [maxX - minX, maxZ - minZ, maxY - minY],
        };
    }, [data]);

    return (
        <Canvas shadows className="three-canvas">
            <PerspectiveCamera
                makeDefault
                position={[
                    bounds.center[0] + bounds.size[0],
                    bounds.center[1] + bounds.size[1],
                    bounds.center[2] + bounds.size[2]
                ]}
                fov={50}
            />
            <OrbitControls
                target={bounds.center as [number, number, number]}
                enableDamping
                dampingFactor={0.05}
            />

            {/* Lighting */}
            <ambientLight intensity={0.5} />
            <directionalLight position={[10, 20, 10]} intensity={0.6} />

            {/* Floor reference */}
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[bounds.center[0], 0, bounds.center[2]]}>
                <planeGeometry args={[bounds.size[0] + 2, bounds.size[2] + 2]} />
                <meshStandardMaterial color="#1e293b" transparent opacity={0.5} />
            </mesh>

            {/* Streamlines */}
            {showStreamlines && data.streamlines.length > 0 && (
                <>
                    <Streamlines streamlines={data.streamlines} maxVelocity={maxVelocity} />
                    <AnimatedParticles streamlines={data.streamlines} />
                </>
            )}

            {/* Velocity Vectors */}
            {showVectors && data.velocityVectors.length > 0 && (
                <VelocityVectors vectors={data.velocityVectors} maxVelocity={maxVelocity} />
            )}

            {/* Dead Zones */}
            {showDeadZones && data.deadZones.length > 0 && (
                <DeadZones zones={data.deadZones} />
            )}

            {/* Axes helper */}
            <axesHelper args={[1]} />
        </Canvas>
    );
}
