'use client';

import { Suspense, useState, useEffect, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { v4 as uuidv4 } from 'uuid';
import {
    IRoom,
    ISupplyDiffuser,
    IReturnGrill,
    IObstruction,
    IAirflowParams,
    RoomType,
    CreateSimulationRequest
} from '@/types';
import RoomPreview3D from '@/components/editor/RoomPreview3D';

// useSearchParams needs a Suspense boundary above it, otherwise prerendering
// /editor fails at build time.
export default function EditorPage() {
    return (
        <Suspense
            fallback={
                <div className="min-h-screen bg-slate-900 flex items-center justify-center text-slate-300">
                    Loading editor...
                </div>
            }
        >
            <Editor />
        </Suspense>
    );
}

function Editor() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const roomId = searchParams.get('roomId');

    // Room state
    const [roomName, setRoomName] = useState('New Cleanroom');
    const [roomType, setRoomType] = useState<RoomType>('cleanroom');
    const [length, setLength] = useState(10);
    const [width, setWidth] = useState(8);
    const [height, setHeight] = useState(3);

    // Configuration state
    const [supplyDiffusers, setSupplyDiffusers] = useState<ISupplyDiffuser[]>([]);
    const [returnGrills, setReturnGrills] = useState<IReturnGrill[]>([]);
    const [obstructions, setObstructions] = useState<IObstruction[]>([]);
    const [airflowParams, setAirflowParams] = useState<IAirflowParams>({
        targetACH: 20,
        temperature: 293.15,
    });

    // UI state
    const [activeTab, setActiveTab] = useState<'room' | 'vents' | 'objects' | 'params'>('room');
    const [saving, setSaving] = useState(false);
    const [simulating, setSimulating] = useState(false);
    const [savedRoomId, setSavedRoomId] = useState<string | null>(roomId);
    const [error, setError] = useState<string | null>(null);
    const [simulationId, setSimulationId] = useState<string | null>(null);

    // Load existing room
    useEffect(() => {
        if (roomId) {
            loadRoom(roomId);
        }
    }, [roomId]);

    async function loadRoom(id: string) {
        try {
            const res = await fetch(`/api/room/${id}`);
            const data = await res.json();
            if (data.success) {
                const room = data.data;
                setRoomName(room.name);
                setRoomType(room.type);
                setLength(room.dimensions.length);
                setWidth(room.dimensions.width);
                setHeight(room.dimensions.height);
                setSavedRoomId(id);
            }
        } catch (err) {
            console.error('Failed to load room:', err);
        }
    }

    async function saveRoom() {
        setSaving(true);
        setError(null);

        try {
            const roomData = {
                name: roomName,
                type: roomType,
                dimensions: { length, width, height },
            };

            const res = savedRoomId
                ? await fetch(`/api/room/${savedRoomId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(roomData),
                })
                : await fetch('/api/room', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(roomData),
                });

            const data = await res.json();

            if (data.success) {
                setSavedRoomId(data.data._id);
            } else {
                setError(data.error);
            }
        } catch (err) {
            setError('Failed to save room');
        } finally {
            setSaving(false);
        }
    }

    function addSupplyDiffuser() {
        const newDiffuser: ISupplyDiffuser = {
            id: uuidv4(),
            name: `Supply ${supplyDiffusers.length + 1}`,
            position: { x: length / 2, y: width / 2, z: height },
            size: { width: 0.6, height: 0.6 },
            flowType: 'rpm',
            fanRPM: 1200,
            fanDiameter: 0.3,
        };
        setSupplyDiffusers([...supplyDiffusers, newDiffuser]);
    }

    function addReturnGrill() {
        const newGrill: IReturnGrill = {
            id: uuidv4(),
            name: `Return ${returnGrills.length + 1}`,
            position: { x: 0, y: width / 2, z: 0.3 },
            size: { width: 0.4, height: 0.2 },
        };
        setReturnGrills([...returnGrills, newGrill]);
    }

    function addObstruction(type: 'equipment' | 'table' | 'human') {
        const newObs: IObstruction = {
            id: uuidv4(),
            name: `${type} ${obstructions.length + 1}`,
            type,
            shape: type === 'human' ? 'cylinder' : 'cuboid',
            position: { x: length / 2, y: width / 2, z: 0 },
            dimensions: type === 'table'
                ? { width: 1.5, height: 0.75, depth: 0.8 }
                : { width: 1, height: 1.5, depth: 1 },
            humanPosture: type === 'human' ? 'standing' : undefined,
        };
        setObstructions([...obstructions, newObs]);
    }

    async function runSimulation() {
        if (!savedRoomId) {
            setError('Please save the room first');
            return;
        }

        if (supplyDiffusers.length === 0) {
            setError('Add at least one supply diffuser');
            return;
        }

        if (returnGrills.length === 0) {
            setError('Add at least one return grill');
            return;
        }

        setSimulating(true);
        setError(null);

        try {
            const request: CreateSimulationRequest = {
                roomId: savedRoomId,
                supplyDiffusers,
                returnGrills,
                obstructions,
                airflowParams,
            };

            const res = await fetch('/api/simulation', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(request),
            });

            const data = await res.json();

            if (data.success) {
                setSimulationId(data.data.simulationId);

                if (data.data.reused && data.data.status === 'completed') {
                    router.push(`/viewer/${data.data.simulationId}`);
                } else {
                    router.push(`/viewer/${data.data.simulationId}?polling=true`);
                }
            } else {
                setError(data.error);
            }
        } catch (err) {
            setError('Failed to start simulation');
        } finally {
            setSimulating(false);
        }
    }

    return (
        <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex">
            {/* Left Panel - Controls */}
            <div className="w-96 border-r border-slate-700/50 bg-slate-900/80 backdrop-blur-xl flex flex-col">
                {/* Header */}
                <div className="p-4 border-b border-slate-700/50">
                    <div className="flex items-center gap-2 mb-4">
                        <button onClick={() => router.push('/')} className="text-slate-400 hover:text-white">
                            ← Back
                        </button>
                    </div>
                    <h1 className="text-lg font-bold text-white">Room Editor</h1>
                    <p className="text-sm text-slate-400">Configure your cleanroom simulation</p>
                </div>

                {/* Tabs */}
                <div className="flex border-b border-slate-700/50">
                    {(['room', 'vents', 'objects', 'params'] as const).map((tab) => (
                        <button
                            key={tab}
                            onClick={() => setActiveTab(tab)}
                            className={`flex-1 py-3 text-sm font-medium capitalize transition-colors ${activeTab === tab
                                    ? 'text-cyan-400 border-b-2 border-cyan-400'
                                    : 'text-slate-400 hover:text-white'
                                }`}
                        >
                            {tab}
                        </button>
                    ))}
                </div>

                {/* Tab Content */}
                <div className="flex-1 overflow-y-auto p-4">
                    {activeTab === 'room' && (
                        <div className="space-y-4">
                            <div>
                                <label className="block text-sm text-slate-400 mb-1">Room Name</label>
                                <input
                                    type="text"
                                    value={roomName}
                                    onChange={(e) => setRoomName(e.target.value)}
                                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white focus:outline-none focus:border-cyan-500"
                                />
                            </div>

                            <div>
                                <label className="block text-sm text-slate-400 mb-1">Room Type</label>
                                <select
                                    value={roomType}
                                    onChange={(e) => setRoomType(e.target.value as RoomType)}
                                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white focus:outline-none focus:border-cyan-500"
                                >
                                    <option value="cleanroom">Cleanroom</option>
                                    <option value="lab">Laboratory</option>
                                    <option value="production">Production Area</option>
                                    <option value="corridor">Corridor</option>
                                </select>
                            </div>

                            <div className="grid grid-cols-3 gap-3">
                                <div>
                                    <label className="block text-sm text-slate-400 mb-1">Length (m)</label>
                                    <input
                                        type="number"
                                        value={length}
                                        onChange={(e) => setLength(parseFloat(e.target.value) || 1)}
                                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white focus:outline-none focus:border-cyan-500"
                                        min="1" step="0.5"
                                    />
                                </div>
                                <div>
                                    <label className="block text-sm text-slate-400 mb-1">Width (m)</label>
                                    <input
                                        type="number"
                                        value={width}
                                        onChange={(e) => setWidth(parseFloat(e.target.value) || 1)}
                                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white focus:outline-none focus:border-cyan-500"
                                        min="1" step="0.5"
                                    />
                                </div>
                                <div>
                                    <label className="block text-sm text-slate-400 mb-1">Height (m)</label>
                                    <input
                                        type="number"
                                        value={height}
                                        onChange={(e) => setHeight(parseFloat(e.target.value) || 1)}
                                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white focus:outline-none focus:border-cyan-500"
                                        min="1" step="0.5"
                                    />
                                </div>
                            </div>

                            <div className="p-3 bg-slate-800/50 rounded-lg">
                                <p className="text-sm text-slate-400">
                                    Volume: <span className="text-white">{(length * width * height).toFixed(1)} m³</span>
                                </p>
                            </div>

                            <button
                                onClick={saveRoom}
                                disabled={saving}
                                className="w-full py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg font-medium disabled:opacity-50 transition-colors"
                            >
                                {saving ? 'Saving...' : savedRoomId ? 'Update Room' : 'Save Room'}
                            </button>
                        </div>
                    )}

                    {activeTab === 'vents' && (
                        <div className="space-y-4">
                            <div>
                                <div className="flex items-center justify-between mb-2">
                                    <h3 className="text-sm font-medium text-white">Supply Diffusers</h3>
                                    <button
                                        onClick={addSupplyDiffuser}
                                        className="text-xs px-2 py-1 bg-cyan-600 text-white rounded hover:bg-cyan-500"
                                    >
                                        + Add
                                    </button>
                                </div>
                                <div className="space-y-2">
                                    {supplyDiffusers.map((d, i) => (
                                        <div key={d.id} className="p-3 bg-slate-800/50 rounded-lg">
                                            <div className="flex items-center justify-between mb-2">
                                                <span className="text-sm text-white">{d.name}</span>
                                                <button
                                                    onClick={() => setSupplyDiffusers(supplyDiffusers.filter(x => x.id !== d.id))}
                                                    className="text-red-400 hover:text-red-300 text-xs"
                                                >
                                                    Remove
                                                </button>
                                            </div>
                                            <div className="grid grid-cols-2 gap-2 text-xs">
                                                <div>
                                                    <label className="text-slate-400">RPM</label>
                                                    <input
                                                        type="number"
                                                        value={d.fanRPM || 1200}
                                                        onChange={(e) => {
                                                            const updated = [...supplyDiffusers];
                                                            updated[i].fanRPM = parseInt(e.target.value) || 0;
                                                            setSupplyDiffusers(updated);
                                                        }}
                                                        className="w-full px-2 py-1 bg-slate-700 rounded text-white"
                                                    />
                                                </div>
                                                <div>
                                                    <label className="text-slate-400">Size (m)</label>
                                                    <input
                                                        type="number"
                                                        value={d.size.width}
                                                        onChange={(e) => {
                                                            const updated = [...supplyDiffusers];
                                                            const size = parseFloat(e.target.value) || 0.1;
                                                            updated[i].size = { width: size, height: size };
                                                            setSupplyDiffusers(updated);
                                                        }}
                                                        className="w-full px-2 py-1 bg-slate-700 rounded text-white"
                                                        step="0.1"
                                                    />
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                    {supplyDiffusers.length === 0 && (
                                        <p className="text-sm text-slate-400 text-center py-4">No supply diffusers added</p>
                                    )}
                                </div>
                            </div>

                            <hr className="border-slate-700" />

                            <div>
                                <div className="flex items-center justify-between mb-2">
                                    <h3 className="text-sm font-medium text-white">Return Grills</h3>
                                    <button
                                        onClick={addReturnGrill}
                                        className="text-xs px-2 py-1 bg-orange-600 text-white rounded hover:bg-orange-500"
                                    >
                                        + Add
                                    </button>
                                </div>
                                <div className="space-y-2">
                                    {returnGrills.map((g, i) => (
                                        <div key={g.id} className="p-3 bg-slate-800/50 rounded-lg">
                                            <div className="flex items-center justify-between">
                                                <span className="text-sm text-white">{g.name}</span>
                                                <button
                                                    onClick={() => setReturnGrills(returnGrills.filter(x => x.id !== g.id))}
                                                    className="text-red-400 hover:text-red-300 text-xs"
                                                >
                                                    Remove
                                                </button>
                                            </div>
                                        </div>
                                    ))}
                                    {returnGrills.length === 0 && (
                                        <p className="text-sm text-slate-400 text-center py-4">No return grills added</p>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}

                    {activeTab === 'objects' && (
                        <div className="space-y-4">
                            <div className="flex gap-2">
                                <button
                                    onClick={() => addObstruction('equipment')}
                                    className="flex-1 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-sm"
                                >
                                    + Equipment
                                </button>
                                <button
                                    onClick={() => addObstruction('table')}
                                    className="flex-1 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-sm"
                                >
                                    + Table
                                </button>
                                <button
                                    onClick={() => addObstruction('human')}
                                    className="flex-1 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-sm"
                                >
                                    + Human
                                </button>
                            </div>

                            <div className="space-y-2">
                                {obstructions.map((o) => (
                                    <div key={o.id} className="p-3 bg-slate-800/50 rounded-lg">
                                        <div className="flex items-center justify-between">
                                            <div>
                                                <span className="text-sm text-white capitalize">{o.type}</span>
                                                <span className="text-xs text-slate-400 ml-2">
                                                    ({o.position.x.toFixed(1)}, {o.position.y.toFixed(1)}, {o.position.z.toFixed(1)})
                                                </span>
                                            </div>
                                            <button
                                                onClick={() => setObstructions(obstructions.filter(x => x.id !== o.id))}
                                                className="text-red-400 hover:text-red-300 text-xs"
                                            >
                                                Remove
                                            </button>
                                        </div>
                                    </div>
                                ))}
                                {obstructions.length === 0 && (
                                    <p className="text-sm text-slate-400 text-center py-4">No obstructions added</p>
                                )}
                            </div>
                        </div>
                    )}

                    {activeTab === 'params' && (
                        <div className="space-y-4">
                            <div>
                                <label className="block text-sm text-slate-400 mb-1">Target ACH (Air Changes/Hour)</label>
                                <input
                                    type="number"
                                    value={airflowParams.targetACH}
                                    onChange={(e) => setAirflowParams({ ...airflowParams, targetACH: parseInt(e.target.value) || 1 })}
                                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white"
                                    min="1"
                                />
                            </div>

                            <div>
                                <label className="block text-sm text-slate-400 mb-1">Temperature (°C)</label>
                                <input
                                    type="number"
                                    value={Math.round((airflowParams.temperature || 293.15) - 273.15)}
                                    onChange={(e) => setAirflowParams({ ...airflowParams, temperature: (parseInt(e.target.value) || 20) + 273.15 })}
                                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white"
                                />
                            </div>
                        </div>
                    )}
                </div>

                {/* Error Display */}
                {error && (
                    <div className="p-3 mx-4 mb-4 bg-red-500/10 border border-red-500/30 rounded-lg">
                        <p className="text-sm text-red-400">{error}</p>
                    </div>
                )}

                {/* Run Simulation Button */}
                <div className="p-4 border-t border-slate-700/50">
                    <button
                        onClick={runSimulation}
                        disabled={simulating || !savedRoomId}
                        className="w-full py-3 bg-gradient-to-r from-cyan-500 to-blue-600 text-white rounded-lg font-medium disabled:opacity-50 hover:from-cyan-400 hover:to-blue-500 transition-all shadow-lg shadow-cyan-500/25"
                    >
                        {simulating ? 'Starting Simulation...' : '🚀 Run Simulation'}
                    </button>
                </div>
            </div>

            {/* Right Panel - 3D Preview */}
            <div className="flex-1 relative">
                <RoomPreview3D
                    length={length}
                    width={width}
                    height={height}
                    supplyDiffusers={supplyDiffusers}
                    returnGrills={returnGrills}
                    obstructions={obstructions}
                />

                {/* Legend */}
                <div className="absolute bottom-4 left-4 p-3 bg-slate-900/80 backdrop-blur-xl rounded-lg border border-slate-700/50">
                    <div className="flex gap-4 text-xs">
                        <div className="flex items-center gap-2">
                            <div className="w-3 h-3 rounded bg-cyan-500" />
                            <span className="text-slate-300">Supply</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <div className="w-3 h-3 rounded bg-orange-500" />
                            <span className="text-slate-300">Return</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <div className="w-3 h-3 rounded bg-purple-500" />
                            <span className="text-slate-300">Object</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
