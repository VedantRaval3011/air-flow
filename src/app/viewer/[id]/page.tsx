'use client';

import { useState, useEffect, use } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { ISimulation, IVisualizationData, SimulationStatus } from '@/types';
import AirflowViewer3D from '@/components/viewer/AirflowViewer3D';

export default function ViewerPage({ params }: { params: Promise<{ id: string }> }) {
    const resolvedParams = use(params);
    const router = useRouter();
    const searchParams = useSearchParams();
    const shouldPoll = searchParams.get('polling') === 'true';

    const [simulation, setSimulation] = useState<ISimulation | null>(null);
    const [visualizationData, setVisualizationData] = useState<IVisualizationData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Visualization options
    const [showStreamlines, setShowStreamlines] = useState(true);
    const [showVectors, setShowVectors] = useState(true);
    const [showDeadZones, setShowDeadZones] = useState(true);
    const [colorMode, setColorMode] = useState<'velocity' | 'pressure'>('velocity');

    useEffect(() => {
        fetchSimulation();

        if (shouldPoll) {
            const interval = setInterval(fetchSimulation, 2000);
            return () => clearInterval(interval);
        }
    }, [resolvedParams.id, shouldPoll]);

    async function fetchSimulation() {
        try {
            const res = await fetch(`/api/simulation/${resolvedParams.id}`);
            const data = await res.json();

            if (data.success) {
                setSimulation(data.data);

                if (data.data.status === 'completed') {
                    fetchVisualizationData();
                }
            } else {
                setError(data.error);
            }
        } catch (err) {
            setError('Failed to fetch simulation');
        } finally {
            setLoading(false);
        }
    }

    async function fetchVisualizationData() {
        try {
            const res = await fetch(`/api/results/${resolvedParams.id}`);
            const data = await res.json();

            if (data.success) {
                setVisualizationData(data.data);
            }
        } catch (err) {
            console.error('Failed to fetch visualization data:', err);
        }
    }

    const getStatusInfo = (status: SimulationStatus) => {
        switch (status) {
            case 'pending': return { color: 'bg-yellow-500', text: 'Queued' };
            case 'meshing': return { color: 'bg-blue-500', text: 'Generating Mesh' };
            case 'running': return { color: 'bg-cyan-500', text: 'Computing' };
            case 'postprocessing': return { color: 'bg-purple-500', text: 'Processing Results' };
            case 'completed': return { color: 'bg-green-500', text: 'Completed' };
            case 'failed': return { color: 'bg-red-500', text: 'Failed' };
            default: return { color: 'bg-gray-500', text: status };
        }
    };

    if (loading) {
        return (
            <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center">
                <div className="text-center">
                    <div className="w-12 h-12 border-3 border-cyan-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
                    <p className="text-slate-400">Loading simulation...</p>
                </div>
            </div>
        );
    }

    if (error || !simulation) {
        return (
            <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center">
                <div className="text-center">
                    <p className="text-red-400 mb-4">{error || 'Simulation not found'}</p>
                    <Link href="/" className="text-cyan-400 hover:text-cyan-300">
                        ← Back to Dashboard
                    </Link>
                </div>
            </div>
        );
    }

    const statusInfo = getStatusInfo(simulation.status);

    // Show progress for non-completed simulations
    if (simulation.status !== 'completed') {
        return (
            <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
                <header className="border-b border-slate-700/50 bg-slate-900/80 backdrop-blur-xl">
                    <div className="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between">
                        <Link href="/" className="text-slate-400 hover:text-white">← Back</Link>
                        <h1 className="text-lg font-bold text-white">Simulation Progress</h1>
                        <div />
                    </div>
                </header>

                <div className="max-w-xl mx-auto px-6 py-16">
                    <div className="p-8 rounded-2xl bg-slate-800/50 border border-slate-700/50">
                        <div className="text-center mb-8">
                            <div className={`w-16 h-16 rounded-full ${statusInfo.color} mx-auto mb-4 flex items-center justify-center ${simulation.status !== 'failed' ? 'animate-pulse' : ''
                                }`}>
                                {simulation.status === 'failed' ? (
                                    <span className="text-2xl">✕</span>
                                ) : (
                                    <div className="w-8 h-8 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                )}
                            </div>
                            <h2 className="text-xl font-semibold text-white mb-1">{statusInfo.text}</h2>
                            <p className="text-slate-400">{simulation.statusMessage}</p>
                        </div>

                        {/* Progress Bar */}
                        <div className="mb-6">
                            <div className="flex justify-between text-sm text-slate-400 mb-2">
                                <span>Progress</span>
                                <span>{simulation.progress}%</span>
                            </div>
                            <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                                <div
                                    className="h-full bg-gradient-to-r from-cyan-500 to-blue-600 transition-all duration-500"
                                    style={{ width: `${simulation.progress}%` }}
                                />
                            </div>
                        </div>

                        {/* Error message */}
                        {simulation.error && (
                            <div className="p-4 bg-red-500/10 border border-red-500/30 rounded-lg mb-6">
                                <p className="text-sm text-red-400">{simulation.error}</p>
                            </div>
                        )}

                        {/* Stages */}
                        <div className="space-y-3">
                            {[
                                { id: 'pending', label: 'Queued' },
                                { id: 'meshing', label: 'Mesh Generation' },
                                { id: 'running', label: 'Flow Computation' },
                                { id: 'postprocessing', label: 'Post-Processing' },
                                { id: 'completed', label: 'Complete' },
                            ].map((stage, i) => {
                                const stages = ['pending', 'meshing', 'running', 'postprocessing', 'completed'];
                                const currentIdx = stages.indexOf(simulation.status);
                                const stageIdx = stages.indexOf(stage.id);
                                const isComplete = stageIdx < currentIdx;
                                const isCurrent = stageIdx === currentIdx;

                                return (
                                    <div key={stage.id} className="flex items-center gap-3">
                                        <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs ${isComplete ? 'bg-green-500 text-white' :
                                                isCurrent ? 'bg-cyan-500 text-white animate-pulse' :
                                                    'bg-slate-700 text-slate-400'
                                            }`}>
                                            {isComplete ? '✓' : i + 1}
                                        </div>
                                        <span className={isComplete || isCurrent ? 'text-white' : 'text-slate-500'}>
                                            {stage.label}
                                        </span>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    // Show visualization for completed simulation
    return (
        <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex">
            {/* Left Panel - Controls */}
            <div className="w-80 border-r border-slate-700/50 bg-slate-900/80 backdrop-blur-xl flex flex-col">
                <div className="p-4 border-b border-slate-700/50">
                    <Link href="/" className="text-slate-400 hover:text-white text-sm mb-2 inline-block">
                        ← Back to Dashboard
                    </Link>
                    <h1 className="text-lg font-bold text-white">Airflow Results</h1>
                    <p className="text-sm text-slate-400">Simulation completed</p>
                </div>

                {/* Visualization Controls */}
                <div className="flex-1 overflow-y-auto p-4 space-y-6">
                    <div>
                        <h3 className="text-sm font-medium text-white mb-3">Display Options</h3>
                        <div className="space-y-3">
                            <label className="flex items-center gap-3 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={showStreamlines}
                                    onChange={(e) => setShowStreamlines(e.target.checked)}
                                    className="w-4 h-4 rounded bg-slate-700 border-slate-600 text-cyan-500 focus:ring-cyan-500"
                                />
                                <span className="text-sm text-slate-300">Streamlines</span>
                            </label>
                            <label className="flex items-center gap-3 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={showVectors}
                                    onChange={(e) => setShowVectors(e.target.checked)}
                                    className="w-4 h-4 rounded bg-slate-700 border-slate-600 text-cyan-500 focus:ring-cyan-500"
                                />
                                <span className="text-sm text-slate-300">Velocity Vectors</span>
                            </label>
                            <label className="flex items-center gap-3 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={showDeadZones}
                                    onChange={(e) => setShowDeadZones(e.target.checked)}
                                    className="w-4 h-4 rounded bg-slate-700 border-slate-600 text-cyan-500 focus:ring-cyan-500"
                                />
                                <span className="text-sm text-slate-300">Dead Zones</span>
                            </label>
                        </div>
                    </div>

                    <hr className="border-slate-700" />

                    {/* Statistics */}
                    {visualizationData?.statistics && (
                        <div>
                            <h3 className="text-sm font-medium text-white mb-3">Flow Statistics</h3>
                            <div className="space-y-2 text-sm">
                                <div className="flex justify-between">
                                    <span className="text-slate-400">Max Velocity</span>
                                    <span className="text-white">{visualizationData.statistics.maxVelocity.toFixed(2)} m/s</span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-slate-400">Avg Velocity</span>
                                    <span className="text-white">{visualizationData.statistics.avgVelocity.toFixed(2)} m/s</span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-slate-400">Min Velocity</span>
                                    <span className="text-white">{visualizationData.statistics.minVelocity.toFixed(2)} m/s</span>
                                </div>
                            </div>
                        </div>
                    )}

                    <hr className="border-slate-700" />

                    {/* Dead Zones */}
                    {visualizationData?.deadZones && visualizationData.deadZones.length > 0 && (
                        <div>
                            <h3 className="text-sm font-medium text-white mb-3">
                                Dead Zones ({visualizationData.deadZones.length})
                            </h3>
                            <div className="space-y-2">
                                {visualizationData.deadZones.map((zone, i) => (
                                    <div key={i} className="p-2 bg-red-500/10 border border-red-500/30 rounded text-xs">
                                        <p className="text-red-400">
                                            Location: ({zone.position.x.toFixed(1)}, {zone.position.y.toFixed(1)}, {zone.position.z.toFixed(1)})
                                        </p>
                                        <p className="text-slate-400">
                                            Velocity: {zone.velocityMagnitude.toFixed(3)} m/s
                                        </p>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Color Legend */}
                    <div>
                        <h3 className="text-sm font-medium text-white mb-3">Velocity Scale</h3>
                        <div className="h-4 rounded bg-gradient-to-r from-blue-500 via-green-500 via-yellow-500 to-red-500" />
                        <div className="flex justify-between text-xs text-slate-400 mt-1">
                            <span>0 m/s</span>
                            <span>{(visualizationData?.statistics?.maxVelocity || 3).toFixed(1)} m/s</span>
                        </div>
                    </div>
                </div>

                {/* Actions */}
                <div className="p-4 border-t border-slate-700/50">
                    <Link
                        href={`/editor?roomId=${simulation.roomId}`}
                        className="block w-full py-2 text-center bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-sm transition-colors"
                    >
                        Modify & Re-run
                    </Link>
                </div>
            </div>

            {/* Right Panel - 3D Viewer */}
            <div className="flex-1">
                {visualizationData ? (
                    <AirflowViewer3D
                        data={visualizationData}
                        showStreamlines={showStreamlines}
                        showVectors={showVectors}
                        showDeadZones={showDeadZones}
                    />
                ) : (
                    <div className="w-full h-full flex items-center justify-center">
                        <div className="w-8 h-8 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" />
                    </div>
                )}
            </div>
        </div>
    );
}
