/**
 * Built-in CFD engine entry point.
 *
 * Runs entirely in the Node process - no WSL, Docker or OpenFOAM install - and
 * writes the same result files the OpenFOAM path produces, so the API and the
 * viewer do not care which engine ran.
 */

import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { IRoomDocument } from '@/db/models/Room';
import { IConfigurationDocument } from '@/db/models/Configuration';
import { ISimulationResults } from '@/types';
import { buildGrid } from './grid';
import { solveAirflow } from './airflowSolver';
import { buildRunReport, summarizeField } from './postprocess';

export interface BuiltinRunOptions {
  /** Reports coarse progress (0-1) plus a human-readable stage message */
  onProgress?: (fraction: number, message: string) => void | Promise<void>;
  maxCells?: number;
  maxSteps?: number;
  targetCellSize?: number;
}

export async function runBuiltinSimulation(
  resultsPath: string,
  room: IRoomDocument,
  config: IConfigurationDocument,
  options: BuiltinRunOptions = {}
): Promise<ISimulationResults> {
  const report = options.onProgress ?? (() => undefined);

  const maxCells = options.maxCells ?? numberFromEnv('SOLVER_MAX_CELLS', 40000);
  const maxSteps = options.maxSteps ?? numberFromEnv('SOLVER_MAX_STEPS', 240);
  const targetCellSize = options.targetCellSize ?? numberFromEnv('SOLVER_CELL_SIZE', 0.2);

  await report(0.05, 'Building computational grid...');
  const grid = buildGrid(room, config, { maxCells, targetCellSize });

  if (grid.supplyFlow <= 0) {
    throw new Error(
      'No supply airflow could be derived from the configuration: set a flow rate, fan RPM or target ACH.'
    );
  }

  const progressFloor = 0.1;
  const progressCeiling = 0.85;
  let lastReported = 0;

  await report(progressFloor, `Solving flow field on ${grid.nx}x${grid.ny}x${grid.nz} cells...`);

  const solution = solveAirflow(grid, {
    maxSteps,
    temperature: config.airflowParams?.temperature,
    onProgress: (fraction) => {
      // The solver is synchronous, so progress is buffered and flushed below.
      lastReported = progressFloor + fraction * (progressCeiling - progressFloor);
    },
  });

  await report(Math.max(lastReported, progressCeiling), 'Extracting streamlines and dead zones...');

  const summary = summarizeField(grid, solution);
  const runReport = buildRunReport(grid, solution);

  await mkdir(resultsPath, { recursive: true });

  const streamlinesPath = path.join(resultsPath, 'streamlines.json');
  const velocityPath = path.join(resultsPath, 'velocity.json');
  const pressurePath = path.join(resultsPath, 'pressure.json');
  const reportPath = path.join(resultsPath, 'report.json');

  await Promise.all([
    writeFile(streamlinesPath, JSON.stringify(summary.streamlines)),
    writeFile(velocityPath, JSON.stringify(summary.velocityVectors)),
    writeFile(pressurePath, JSON.stringify(summary.pressure)),
    writeFile(reportPath, JSON.stringify(runReport, null, 2)),
  ]);

  await report(0.95, 'Results written.');

  return {
    velocityField: velocityPath,
    pressureField: pressurePath,
    streamlines: streamlinesPath,
    deadZones: summary.deadZones,
    statistics: summary.statistics,
  };
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export { buildGrid } from './grid';
export { solveAirflow } from './airflowSolver';
export { summarizeField, buildRunReport } from './postprocess';
