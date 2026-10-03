'use client';

import { useEffect, useState } from 'react';
import { Facility, FacilityJob, FacilityResults, FacilitySimulationOptions } from '@/lib/facility/types';

export interface StoredResult {
  results: FacilityResults;
  /** The inputs it was computed for, to tell when it is out of date */
  key: string;
}

export interface ActiveRun {
  job: FacilityJob;
  /** 'floor' or the room id of a room study */
  scope: string;
  key: string;
}

/**
 * CFD runs for the facility page: one whole-floor result plus one result per
 * studied room. One run at a time; its progress is polled until it finishes.
 */
export function useCfdRuns(facility: Facility) {
  const [floor, setFloor] = useState<StoredResult | null>(null);
  const [rooms, setRooms] = useState<Record<string, StoredResult>>({});
  const [active, setActive] = useState<ActiveRun | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(scope: string, options: FacilitySimulationOptions, key: string) {
    setError(null);
    const res = await fetch('/api/facility/simulations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ facility, options }),
    });
    const body = await res.json();
    if (!body.success) {
      setError(body.error ?? 'Could not start the simulation');
      return;
    }
    setActive({ job: body.data, scope, key });
  }

  const jobId = active?.job.id;
  useEffect(() => {
    if (!jobId || !active) return;
    const { scope, key } = active;
    let cancelled = false;
    const poll = async () => {
      const res = await fetch(`/api/facility/simulations/${jobId}?results`);
      const body = await res.json();
      if (cancelled || !body.success) return;
      const job: FacilityJob = body.data.job;
      if (job.status === 'completed' && body.data.results) {
        const stored = { results: body.data.results as FacilityResults, key };
        if (scope === 'floor') setFloor(stored);
        else setRooms((r) => ({ ...r, [scope]: stored }));
        setActive(null);
      } else if (job.status === 'failed') {
        setError(job.error ?? 'Simulation failed');
        setActive(null);
      } else {
        setActive((a) => (a && a.job.id === job.id ? { ...a, job } : a));
      }
    };
    void poll();
    const timer = setInterval(poll, 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // The run identity is the job id; scope and key travel with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  return {
    floor,
    rooms,
    active,
    error,
    runFloor: (options: FacilitySimulationOptions, key: string) => run('floor', options, key),
    runRoom: (roomId: string, options: FacilitySimulationOptions, key: string) => run(roomId, options, key),
    clearRoom: (roomId: string) =>
      setRooms((r) => {
        const next = { ...r };
        delete next[roomId];
        return next;
      }),
  };
}
