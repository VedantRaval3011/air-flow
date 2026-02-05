'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { IRoom, ISimulation } from '@/types';

export default function HomePage() {
  const [rooms, setRooms] = useState<IRoom[]>([]);
  const [simulations, setSimulations] = useState<ISimulation[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchData();
  }, []);

  async function fetchData() {
    try {
      const [roomsRes, simsRes] = await Promise.all([
        fetch('/api/room'),
        fetch('/api/simulation'),
      ]);
      const roomsData = await roomsRes.json();
      const simsData = await simsRes.json();

      if (roomsData.success) setRooms(roomsData.data);
      if (simsData.success) setSimulations(simsData.data);
    } catch (error) {
      console.error('Failed to fetch data:', error);
    } finally {
      setLoading(false);
    }
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed': return 'bg-green-500';
      case 'running': return 'bg-blue-500 animate-pulse';
      case 'failed': return 'bg-red-500';
      case 'pending': return 'bg-yellow-500';
      default: return 'bg-gray-500';
    }
  };

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
      {/* Header */}
      <header className="border-b border-slate-700/50 backdrop-blur-xl bg-slate-900/50">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-400 to-blue-600 flex items-center justify-center">
                <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
                </svg>
              </div>
              <div>
                <h1 className="text-xl font-bold text-white">AirFlow CFD</h1>
                <p className="text-xs text-slate-400">Pharma Cleanroom Simulation</p>
              </div>
            </div>
            <Link
              href="/editor"
              className="px-4 py-2 bg-gradient-to-r from-cyan-500 to-blue-600 text-white rounded-lg font-medium hover:from-cyan-400 hover:to-blue-500 transition-all shadow-lg shadow-cyan-500/25"
            >
              + New Simulation
            </Link>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-6 py-8">
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="w-8 h-8 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <div className="grid lg:grid-cols-2 gap-8">
            {/* Rooms Section */}
            <section>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-white">Rooms</h2>
                <span className="text-sm text-slate-400">{rooms.length} total</span>
              </div>
              <div className="space-y-3">
                {rooms.length === 0 ? (
                  <div className="p-8 rounded-xl border border-dashed border-slate-700 text-center">
                    <p className="text-slate-400 mb-3">No rooms created yet</p>
                    <Link href="/editor" className="text-cyan-400 hover:text-cyan-300 text-sm">
                      Create your first room →
                    </Link>
                  </div>
                ) : (
                  rooms.map((room) => (
                    <div
                      key={room._id}
                      className="p-4 rounded-xl bg-slate-800/50 border border-slate-700/50 hover:border-slate-600/50 transition-all group"
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <h3 className="font-medium text-white group-hover:text-cyan-400 transition-colors">
                            {room.name}
                          </h3>
                          <p className="text-sm text-slate-400 mt-1">
                            {room.dimensions.length}m × {room.dimensions.width}m × {room.dimensions.height}m
                            <span className="mx-2">•</span>
                            <span className="capitalize">{room.type}</span>
                          </p>
                        </div>
                        <Link
                          href={`/editor?roomId=${room._id}`}
                          className="px-3 py-1.5 text-sm bg-slate-700 hover:bg-slate-600 text-white rounded-lg transition-colors"
                        >
                          Edit
                        </Link>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>

            {/* Simulations Section */}
            <section>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-white">Recent Simulations</h2>
                <span className="text-sm text-slate-400">{simulations.length} total</span>
              </div>
              <div className="space-y-3">
                {simulations.length === 0 ? (
                  <div className="p-8 rounded-xl border border-dashed border-slate-700 text-center">
                    <p className="text-slate-400 mb-3">No simulations run yet</p>
                    <Link href="/editor" className="text-cyan-400 hover:text-cyan-300 text-sm">
                      Start a simulation →
                    </Link>
                  </div>
                ) : (
                  simulations.slice(0, 10).map((sim) => (
                    <div
                      key={sim._id}
                      className="p-4 rounded-xl bg-slate-800/50 border border-slate-700/50 hover:border-slate-600/50 transition-all"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className={`w-2.5 h-2.5 rounded-full ${getStatusColor(sim.status)}`} />
                          <div>
                            <p className="text-sm text-white">
                              {sim.configHash?.slice(0, 8)}...
                            </p>
                            <p className="text-xs text-slate-400 capitalize">
                              {sim.status} • {sim.progress}%
                            </p>
                          </div>
                        </div>
                        {sim.status === 'completed' && (
                          <Link
                            href={`/viewer/${sim._id}`}
                            className="px-3 py-1.5 text-sm bg-gradient-to-r from-cyan-500 to-blue-600 text-white rounded-lg hover:from-cyan-400 hover:to-blue-500 transition-all"
                          >
                            View Results
                          </Link>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>
        )}

        {/* Quick Start Guide */}
        <section className="mt-12">
          <h2 className="text-lg font-semibold text-white mb-4">Quick Start Guide</h2>
          <div className="grid md:grid-cols-4 gap-4">
            {[
              { step: 1, title: 'Create Room', desc: 'Define room dimensions and type' },
              { step: 2, title: 'Add Vents', desc: 'Place supply diffusers and returns' },
              { step: 3, title: 'Add Objects', desc: 'Add equipment, tables, humans' },
              { step: 4, title: 'Run & View', desc: 'Simulate and visualize airflow' },
            ].map((item) => (
              <div
                key={item.step}
                className="p-4 rounded-xl bg-slate-800/30 border border-slate-700/30"
              >
                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-cyan-500/20 to-blue-600/20 flex items-center justify-center text-cyan-400 font-bold mb-3">
                  {item.step}
                </div>
                <h3 className="font-medium text-white text-sm">{item.title}</h3>
                <p className="text-xs text-slate-400 mt-1">{item.desc}</p>
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
