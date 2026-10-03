/**
 * Facility CFD jobs. Runs are keyed by a hash of the layout and options, so
 * re-running an identical state returns the stored results. Status lives in
 * memory while a run is active and is mirrored to disk so it survives a dev
 * server reload; results are plain JSON next to it.
 */

import { createHash } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { runFacilitySimulation } from '@/backend/solver/facilityRun';
import { FacilityJob, FacilityResults, FacilitySimulationRequest } from '@/lib/facility/types';

/** Bump when the model changes so stale cached results are not reused. */
const MODEL_VERSION = 9;
const BASE_DIR = path.join(process.env.SIMULATION_OUTPUT_DIR || './simulations', 'facility');

const store = globalThis as unknown as { __facilityJobs?: Map<string, FacilityJob> };
const active = (store.__facilityJobs ??= new Map<string, FacilityJob>());

const jobDir = (id: string) => path.join(BASE_DIR, id);

export function jobIdFor(request: FacilitySimulationRequest): string {
  return createHash('sha256')
    .update(JSON.stringify({ v: MODEL_VERSION, ...request }))
    .digest('hex')
    .slice(0, 16);
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function persist(job: FacilityJob): Promise<void> {
  await mkdir(jobDir(job.id), { recursive: true });
  await writeFile(path.join(jobDir(job.id), 'status.json'), JSON.stringify(job, null, 2));
}

export async function getJob(id: string): Promise<FacilityJob | null> {
  if (!/^[a-f0-9]{16}$/.test(id)) return null;
  const live = active.get(id);
  if (live) return live;
  const saved = await readJson<FacilityJob>(path.join(jobDir(id), 'status.json'));
  if (saved && saved.status !== 'completed' && saved.status !== 'failed') {
    // Left mid-run by a server restart.
    saved.status = 'failed';
    saved.error = 'The run was interrupted (server restarted). Start it again.';
  }
  return saved;
}

export async function getResults(id: string): Promise<FacilityResults | null> {
  if (!/^[a-f0-9]{16}$/.test(id)) return null;
  return readJson<FacilityResults>(path.join(jobDir(id), 'results.json'));
}

export async function startJob(request: FacilitySimulationRequest): Promise<FacilityJob> {
  const id = jobIdFor(request);
  const existing = await getJob(id);
  if (existing && (existing.status === 'completed' || active.has(id))) return existing;

  const now = new Date().toISOString();
  const job: FacilityJob = { id, status: 'queued', progress: 0, message: 'Queued', createdAt: now, updatedAt: now };
  active.set(id, job);
  await persist(job);

  void execute(job, request);
  return job;
}

async function execute(job: FacilityJob, request: FacilitySimulationRequest): Promise<void> {
  let lastWrite = 0;
  const update = (patch: Partial<FacilityJob>) => {
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    if (Date.now() - lastWrite > 1500) {
      lastWrite = Date.now();
      void persist(job);
    }
  };

  try {
    const results = await runFacilitySimulation(job.id, request.facility, {
      ...request.options,
      onProgress: (fraction, message) =>
        update({
          status: fraction < 0.05 ? 'meshing' : fraction < 0.9 ? 'running' : 'postprocessing',
          progress: Math.round(fraction * 100),
          message,
        }),
    });
    await writeFile(path.join(jobDir(job.id), 'results.json'), JSON.stringify(results));
    Object.assign(job, { status: 'completed', progress: 100, message: 'Completed', updatedAt: new Date().toISOString() });
  } catch (error) {
    Object.assign(job, {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      updatedAt: new Date().toISOString(),
    });
  } finally {
    await persist(job);
    active.delete(job.id);
  }
}
