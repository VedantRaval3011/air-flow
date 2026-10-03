'use client';

import { useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Grid, PerspectiveCamera } from '@react-three/drei';
import * as THREE from 'three';
import { ISupplyDiffuser, IReturnGrill, IObstruction } from '@/types';

interface RoomPreview3DProps {
    length: number;
    width: number;
    height: number;
    supplyDiffusers: ISupplyDiffuser[];
    returnGrills: IReturnGrill[];
    obstructions: IObstruction[];
}

function Room({ length, width, height }: { length: number; width: number; height: number }) {
    return (
        <group>
            {/* Floor */}
            <mesh position={[length / 2, 0, width / 2]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
                <planeGeometry args={[length, width]} />
                <meshStandardMaterial color="#1e293b" side={THREE.DoubleSide} />
            </mesh>

            {/* Walls - translucent */}
            <mesh position={[length / 2, height / 2, 0]}>
                <planeGeometry args={[length, height]} />
                <meshStandardMaterial color="#334155" transparent opacity={0.3} side={THREE.DoubleSide} />
            </mesh>
            <mesh position={[length / 2, height / 2, width]} rotation={[0, Math.PI, 0]}>
                <planeGeometry args={[length, height]} />
                <meshStandardMaterial color="#334155" transparent opacity={0.3} side={THREE.DoubleSide} />
            </mesh>
            <mesh position={[0, height / 2, width / 2]} rotation={[0, Math.PI / 2, 0]}>
                <planeGeometry args={[width, height]} />
                <meshStandardMaterial color="#334155" transparent opacity={0.3} side={THREE.DoubleSide} />
            </mesh>
            <mesh position={[length, height / 2, width / 2]} rotation={[0, -Math.PI / 2, 0]}>
                <planeGeometry args={[width, height]} />
                <meshStandardMaterial color="#334155" transparent opacity={0.3} side={THREE.DoubleSide} />
            </mesh>

            {/* Ceiling outline */}
            <lineSegments position={[length / 2, height, width / 2]}>
                <edgesGeometry args={[new THREE.PlaneGeometry(length, width)]} />
                <lineBasicMaterial color="#475569" />
            </lineSegments>
        </group>
    );
}

function SupplyDiffuser({ diffuser }: { diffuser: ISupplyDiffuser }) {
    const ref = useRef<THREE.Mesh>(null);

    useFrame((state) => {
        const material = ref.current?.material;
        if (material && !Array.isArray(material)) {
            material.opacity = 0.7 + Math.sin(state.clock.elapsedTime * 2) * 0.3;
        }
    });

    return (
        <mesh
            ref={ref}
            position={[diffuser.position.x, diffuser.position.z, diffuser.position.y]}
        >
            <boxGeometry args={[diffuser.size.width, 0.05, diffuser.size.height]} />
            <meshStandardMaterial color="#06b6d4" transparent opacity={0.8} emissive="#06b6d4" emissiveIntensity={0.3} />
        </mesh>
    );
}

function ReturnGrill({ grill }: { grill: IReturnGrill }) {
    return (
        <mesh position={[grill.position.x, grill.position.z, grill.position.y]}>
            <boxGeometry args={[grill.size.width, grill.size.height, 0.05]} />
            <meshStandardMaterial color="#f97316" transparent opacity={0.8} emissive="#f97316" emissiveIntensity={0.3} />
        </mesh>
    );
}

function Obstruction({ obstruction }: { obstruction: IObstruction }) {
    const isHuman = obstruction.type === 'human';
    const color = isHuman ? '#a855f7' : obstruction.type === 'table' ? '#854d0e' : '#6366f1';

    if (obstruction.shape === 'cylinder' || isHuman) {
        const radius = obstruction.radius || 0.25;
        const height = isHuman
            ? (obstruction.humanPosture === 'sitting' ? 1.2 : 1.7)
            : (obstruction.height || 1);

        return (
            <mesh position={[obstruction.position.x, height / 2, obstruction.position.y]}>
                <cylinderGeometry args={[radius, radius, height, 16]} />
                <meshStandardMaterial color={color} transparent opacity={0.8} />
            </mesh>
        );
    }

    const dim = obstruction.dimensions || { width: 1, height: 1, depth: 1 };

    return (
        <mesh position={[obstruction.position.x, (dim.height || 1) / 2, obstruction.position.y]}>
            <boxGeometry args={[dim.width || 1, dim.height || 1, dim.depth || 1]} />
            <meshStandardMaterial color={color} transparent opacity={0.8} />
        </mesh>
    );
}

export default function RoomPreview3D({
    length,
    width,
    height,
    supplyDiffusers,
    returnGrills,
    obstructions,
}: RoomPreview3DProps) {
    return (
        <Canvas shadows className="three-canvas">
            <PerspectiveCamera
                makeDefault
                position={[length * 1.5, height * 1.5, width * 1.5]}
                fov={50}
            />
            <OrbitControls
                target={[length / 2, height / 2, width / 2]}
                maxPolarAngle={Math.PI / 2}
                enableDamping
                dampingFactor={0.05}
            />

            {/* Lighting */}
            <ambientLight intensity={0.4} />
            <directionalLight position={[10, 20, 10]} intensity={0.8} castShadow />
            <pointLight position={[length / 2, height + 2, width / 2]} intensity={0.5} />

            {/* Grid */}
            <Grid
                args={[50, 50]}
                position={[length / 2, 0.01, width / 2]}
                cellSize={1}
                cellThickness={0.5}
                cellColor="#334155"
                sectionSize={5}
                sectionThickness={1}
                sectionColor="#475569"
                fadeDistance={50}
                fadeStrength={1}
                infiniteGrid
            />

            {/* Room */}
            <Room length={length} width={width} height={height} />

            {/* Diffusers */}
            {supplyDiffusers.map((d) => (
                <SupplyDiffuser key={d.id} diffuser={d} />
            ))}

            {/* Returns */}
            {returnGrills.map((g) => (
                <ReturnGrill key={g.id} grill={g} />
            ))}

            {/* Obstructions */}
            {obstructions.map((o) => (
                <Obstruction key={o.id} obstruction={o} />
            ))}

            {/* Axes helper */}
            <axesHelper args={[2]} position={[0, 0.01, 0]} />
        </Canvas>
    );
}
