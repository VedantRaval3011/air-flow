/**
 * Simulation Runner
 *
 * Picks a CFD engine, runs it, and stores the results on the simulation record.
 *
 * ENGINES
 * =======
 * builtin (default)
 *   In-process incompressible solver (src/backend/solver). Needs nothing
 *   installed - works on plain Windows/macOS/Linux with just Node.
 *
 * docker
 *   Runs OpenFOAM inside a container. Requires Docker Desktop and:
 *     docker pull openfoam/openfoam10-paraview510
 *
 * wsl
 *   Runs a native OpenFOAM installed inside WSL2. Requires `wsl --install`
 *   plus OpenFOAM in the distro (see README).
 *
 * mock
 *   Synthetic results, no solve. Only useful for UI work.
 *
 * Selection: OPENFOAM_ENGINE=builtin|docker|wsl|mock|auto (default: auto).
 * `auto` uses Docker or WSL only when they are actually available and falls
 * back to the built-in solver otherwise. If an OpenFOAM run fails part-way,
 * the built-in solver takes over so the simulation still completes.
 *
 * Legacy switches are still honoured: OPENFOAM_SIMULATE=true means `mock`,
 * OPENFOAM_USE_DOCKER=true prefers `docker`.
 */

import { spawn, execFileSync } from 'child_process';
import path from 'path';
import { mkdir } from 'fs/promises';
import connectToDatabase from '@/db/connection';
import Configuration from '@/db/models/Configuration';
import Simulation from '@/db/models/Simulation';
import Room from '@/db/models/Room';
import { generateCaseFiles } from './caseGenerator';
import { generateMockResults, processOpenFOAMResults } from '../postprocess/resultProcessor';
import { runBuiltinSimulation } from '@/backend/solver';
import { IConfigurationDocument } from '@/db/models/Configuration';
import { IRoomDocument } from '@/db/models/Room';
import { ISimulationResults } from '@/types';

// Configuration
const SIMULATION_BASE_DIR = process.env.SIMULATION_OUTPUT_DIR || './simulations';
const USE_DOCKER = process.env.OPENFOAM_USE_DOCKER === 'true';
const SIMULATE_MODE = process.env.OPENFOAM_SIMULATE === 'true';
const DOCKER_IMAGE = process.env.OPENFOAM_DOCKER_IMAGE || 'openfoam/openfoam10-paraview510';
const OPENFOAM_BASHRC = process.env.OPENFOAM_BASHRC || '/opt/openfoam10/etc/bashrc';

export type Engine = 'builtin' | 'docker' | 'wsl' | 'mock';

/**
 * Update simulation status in database
 */
async function updateSimulationStatus(
  simulationId: string,
  status: string,
  progress: number,
  message?: string,
  error?: string
) {
  await connectToDatabase();
  await Simulation.findByIdAndUpdate(simulationId, {
    status,
    progress,
    statusMessage: message,
    error,
    ...(status === 'running' && !error ? { startedAt: new Date() } : {}),
    ...(status === 'completed' || status === 'failed' ? { completedAt: new Date() } : {}),
  });
}

/**
 * Create simulation case directory
 */
async function createCaseDirectory(simulationId: string): Promise<string> {
  const casePath = path.join(SIMULATION_BASE_DIR, simulationId, 'case');
  const resultsPath = path.join(SIMULATION_BASE_DIR, simulationId, 'results');

  await mkdir(casePath, { recursive: true });
  await mkdir(resultsPath, { recursive: true });

  return casePath;
}

/** Quietly probe for an external tool; never throws. */
function canRun(command: string, args: string[]): boolean {
  try {
    execFileSync(command, args, { stdio: 'ignore', timeout: 15000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function dockerAvailable(): boolean {
  return canRun('docker', ['version', '--format', '{{.Server.Version}}']);
}

/** WSL must exist *and* have an OpenFOAM environment script to be usable. */
function wslOpenFOAMAvailable(): boolean {
  if (process.platform !== 'win32') return false;
  if (!canRun('wsl.exe', ['-e', 'true'])) return false;
  return canRun('wsl.exe', ['-e', 'test', '-f', OPENFOAM_BASHRC]);
}

function nativeOpenFOAMAvailable(): boolean {
  if (process.platform === 'win32') return false;
  return canRun('bash', ['-lc', `test -f ${OPENFOAM_BASHRC}`]);
}

/**
 * Resolve which engine to use, honouring explicit configuration and only
 * selecting an OpenFOAM path when the tooling is really there.
 */
let cachedEngine: Engine | null = null;

export function resolveEngine(): Engine {
  if (cachedEngine) return cachedEngine;
  cachedEngine = detectEngine();
  return cachedEngine;
}

function detectEngine(): Engine {
  const requested = (process.env.OPENFOAM_ENGINE || '').trim().toLowerCase();

  if (requested === 'builtin' || requested === 'mock') return requested;
  if (requested === 'docker') {
    if (dockerAvailable()) return 'docker';
    console.warn('OPENFOAM_ENGINE=docker but Docker is not reachable; using the built-in solver.');
    return 'builtin';
  }
  if (requested === 'wsl' || requested === 'native') {
    if (wslOpenFOAMAvailable() || nativeOpenFOAMAvailable()) return 'wsl';
    console.warn('OPENFOAM_ENGINE=wsl but OpenFOAM is not reachable; using the built-in solver.');
    return 'builtin';
  }

  // Legacy flags.
  if (SIMULATE_MODE) return 'mock';
  if (USE_DOCKER && dockerAvailable()) return 'docker';

  // auto / unset: prefer OpenFOAM if installed, otherwise run in-process.
  if (dockerAvailable()) return 'docker';
  if (wslOpenFOAMAvailable() || nativeOpenFOAMAvailable()) return 'wsl';
  return 'builtin';
}

/**
 * Execute an OpenFOAM command
 */
async function executeOpenFOAMCommand(
  command: string,
  casePath: string,
  simulationId: string,
  statusMessage: string,
  progress: number,
  engine: Engine
): Promise<boolean> {
  await updateSimulationStatus(simulationId, 'running', progress, statusMessage);

  return new Promise((resolve, reject) => {
    const absoluteCase = path.resolve(casePath);
    let file: string;
    let args: string[];

    if (engine === 'docker') {
      const dockerPath = absoluteCase.replace(/\\/g, '/');
      file = 'docker';
      args = [
        'run',
        '--rm',
        '-v',
        `${dockerPath}:/case`,
        '-w',
        '/case',
        DOCKER_IMAGE,
        'bash',
        '-lc',
        command,
      ];
    } else if (process.platform === 'win32') {
      // /mnt/c/... - the drive letter must be lower-case, the rest must not be.
      const posixPath = absoluteCase
        .replace(/\\/g, '/')
        .replace(/^([A-Za-z]):/, (_m, drive: string) => `/mnt/${drive.toLowerCase()}`);
      file = 'wsl.exe';
      args = ['-e', 'bash', '-lc', `cd '${posixPath}' && . ${OPENFOAM_BASHRC} && ${command}`];
    } else {
      file = 'bash';
      args = ['-lc', `cd '${absoluteCase}' && . ${OPENFOAM_BASHRC} && ${command}`];
    }

    console.log(`Executing (${engine}): ${command}`);

    const child = spawn(file, args, {
      cwd: absoluteCase,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stderr = '';
    child.stdout?.on('data', () => {
      /* OpenFOAM is chatty; logs are not needed for control flow */
    });
    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(true);
      } else {
        console.error(`Command failed: ${command}`);
        console.error('stderr:', stderr);
        reject(new Error(`Command '${command}' failed with code ${code}: ${stderr.trim()}`));
      }
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}

/** Run the in-process solver and report progress on the simulation record. */
async function runBuiltinEngine(
  simulationId: string,
  resultsPath: string,
  room: IRoomDocument,
  config: IConfigurationDocument,
  note?: string
): Promise<ISimulationResults> {
  await updateSimulationStatus(
    simulationId,
    'running',
    15,
    note ? `${note} Running built-in CFD solver...` : 'Running built-in CFD solver...'
  );

  return runBuiltinSimulation(resultsPath, room, config, {
    onProgress: async (fraction, message) => {
      const progress = Math.round(15 + fraction * 75);
      const status = fraction >= 0.85 ? 'postprocessing' : 'running';
      await updateSimulationStatus(simulationId, status, progress, message);
    },
  });
}

/** Full OpenFOAM pipeline: mesh, solve, convert, parse. */
async function runOpenFOAMEngine(
  simulationId: string,
  casePath: string,
  resultsPath: string,
  room: IRoomDocument,
  config: IConfigurationDocument,
  engine: Engine
): Promise<ISimulationResults> {
  await updateSimulationStatus(simulationId, 'meshing', 10, 'Running blockMesh...');
  await executeOpenFOAMCommand('blockMesh', casePath, simulationId, 'Generating base mesh...', 15, engine);

  if (config.obstructions && config.obstructions.length > 0) {
    await updateSimulationStatus(simulationId, 'meshing', 20, 'Running snappyHexMesh...');
    await executeOpenFOAMCommand(
      'snappyHexMesh -overwrite',
      casePath,
      simulationId,
      'Refining mesh around obstructions...',
      35,
      engine
    );
  }

  await updateSimulationStatus(simulationId, 'running', 40, 'Running simpleFoam solver...');
  await executeOpenFOAMCommand('simpleFoam', casePath, simulationId, 'Computing flow field...', 75, engine);

  await updateSimulationStatus(simulationId, 'postprocessing', 80, 'Extracting results...');
  await executeOpenFOAMCommand(
    'foamToVTK',
    casePath,
    simulationId,
    'Converting to VTK format...',
    85,
    engine
  );

  await updateSimulationStatus(simulationId, 'postprocessing', 90, 'Processing visualization data...');
  return processOpenFOAMResults(casePath, resultsPath, room, config);
}

/**
 * Main simulation runner function
 */
export async function runSimulation(
  simulationId: string,
  configurationId: string
): Promise<void> {
  try {
    await connectToDatabase();

    // Load configuration and room
    const configuration = await Configuration.findById(configurationId) as IConfigurationDocument | null;
    if (!configuration) {
      throw new Error('Configuration not found');
    }

    const room = await Room.findById(configuration.roomId) as IRoomDocument | null;
    if (!room) {
      throw new Error('Room not found');
    }

    const engine = resolveEngine();
    console.log(`Starting simulation ${simulationId} (engine: ${engine})`);

    // Create case directory
    const casePath = await createCaseDirectory(simulationId);
    const resultsPath = path.join(SIMULATION_BASE_DIR, simulationId, 'results');

    // Update simulation with paths
    await Simulation.findByIdAndUpdate(simulationId, {
      casePath,
      resultsPath,
    });

    // The OpenFOAM case is always written: it documents the run and lets the
    // same case be re-run by hand in OpenFOAM if it is available.
    await updateSimulationStatus(simulationId, 'meshing', 5, 'Generating case files...');
    await generateCaseFiles(casePath, room, configuration);

    let results: ISimulationResults;
    let engineUsed: Engine = engine;

    if (engine === 'mock') {
      await updateSimulationStatus(simulationId, 'running', 50, 'Simulating (mock mode)...');
      await updateSimulationStatus(simulationId, 'postprocessing', 80, 'Generating mock results...');
      results = await generateMockResults(resultsPath, room, configuration);
    } else if (engine === 'builtin') {
      results = await runBuiltinEngine(simulationId, resultsPath, room, configuration);
    } else {
      try {
        results = await runOpenFOAMEngine(
          simulationId,
          casePath,
          resultsPath,
          room,
          configuration,
          engine
        );

        // The OpenFOAM field parser is not implemented yet, so an empty field
        // means "nothing to visualize" - solve in-process instead of shipping
        // a blank result to the viewer.
        if (!results.statistics || results.statistics.maxVelocity <= 0) {
          console.warn(
            `OpenFOAM run for ${simulationId} produced no readable field; falling back to the built-in solver.`
          );
          results = await runBuiltinEngine(
            simulationId,
            resultsPath,
            room,
            configuration,
            'OpenFOAM results could not be read.'
          );
          engineUsed = 'builtin';
        }
      } catch (openfoamError) {
        const detail =
          openfoamError instanceof Error ? openfoamError.message : String(openfoamError);
        console.warn(`OpenFOAM engine failed for ${simulationId}: ${detail}`);
        results = await runBuiltinEngine(
          simulationId,
          resultsPath,
          room,
          configuration,
          'OpenFOAM unavailable.'
        );
        engineUsed = 'builtin';
      }
    }

    const completionMessage =
      engineUsed === 'mock'
        ? 'Simulation completed (mock mode)'
        : engineUsed === 'builtin'
          ? 'Simulation completed (built-in CFD solver)'
          : `Simulation completed (OpenFOAM via ${engineUsed})`;

    await Simulation.findByIdAndUpdate(simulationId, {
      status: 'completed',
      progress: 100,
      statusMessage: completionMessage,
      results,
      error: undefined,
      completedAt: new Date(),
    });

    console.log(`Simulation ${simulationId} completed: ${completionMessage}`);

  } catch (error) {
    console.error(`Simulation ${simulationId} failed:`, error);

    await updateSimulationStatus(
      simulationId,
      'failed',
      0,
      undefined,
      error instanceof Error ? error.message : 'Unknown error'
    );

    throw error;
  }
}
