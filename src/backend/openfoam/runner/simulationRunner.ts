/**
 * OpenFOAM Simulation Runner
 * 
 * This module handles the execution of OpenFOAM CFD simulations.
 * 
 * OPENFOAM SETUP GUIDE:
 * ====================
 * 
 * Option 1: Docker (Recommended for Windows)
 * ------------------------------------------
 * 1. Install Docker Desktop from https://www.docker.com/products/docker-desktop
 * 2. Pull the OpenFOAM image:
 *    docker pull openfoam/openfoam10-paraview510
 * 3. Set environment variable: OPENFOAM_USE_DOCKER=true
 * 
 * Option 2: WSL2 + Native OpenFOAM
 * ---------------------------------
 * 1. Install WSL2: wsl --install
 * 2. Install Ubuntu from Microsoft Store
 * 3. In Ubuntu, install OpenFOAM:
 *    sudo sh -c "wget -O - https://dl.openfoam.org/gpg.key | apt-key add -"
 *    sudo add-apt-repository http://dl.openfoam.org/ubuntu
 *    sudo apt update
 *    sudo apt install openfoam10
 * 4. Set environment variable: OPENFOAM_USE_DOCKER=false
 * 
 * Option 3: Simulated Mode (Development)
 * --------------------------------------
 * Set OPENFOAM_SIMULATE=true to generate mock results without OpenFOAM
 */

import { spawn, execSync } from 'child_process';
import path from 'path';
import { mkdir, writeFile, readdir, cp, rm } from 'fs/promises';
import { existsSync } from 'fs';
import connectToDatabase from '@/db/connection';
import Configuration from '@/db/models/Configuration';
import Simulation from '@/db/models/Simulation';
import Room from '@/db/models/Room';
import { generateCaseFiles } from './caseGenerator';
import { generateMockResults, processOpenFOAMResults } from '../postprocess/resultProcessor';
import { IConfigurationDocument } from '@/db/models/Configuration';
import { IRoomDocument } from '@/db/models/Room';

// Configuration
const SIMULATION_BASE_DIR = process.env.SIMULATION_OUTPUT_DIR || './simulations';
const USE_DOCKER = process.env.OPENFOAM_USE_DOCKER === 'true';
const SIMULATE_MODE = process.env.OPENFOAM_SIMULATE === 'true';
const DOCKER_IMAGE = process.env.OPENFOAM_DOCKER_IMAGE || 'openfoam/openfoam10-paraview510';

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

/**
 * Execute an OpenFOAM command
 */
async function executeOpenFOAMCommand(
  command: string,
  casePath: string,
  simulationId: string,
  statusMessage: string,
  progress: number
): Promise<boolean> {
  await updateSimulationStatus(simulationId, 'running', progress, statusMessage);
  
  return new Promise((resolve, reject) => {
    let fullCommand: string;
    let shell: string;
    let shellArgs: string[];
    
    if (USE_DOCKER) {
      // Run command in Docker container
      const dockerPath = casePath.replace(/\\/g, '/');
      fullCommand = `docker run --rm -v "${dockerPath}:/case" -w /case ${DOCKER_IMAGE} ${command}`;
      shell = 'cmd.exe';
      shellArgs = ['/c', fullCommand];
    } else {
      // Run via WSL or native
      const wslPath = casePath.replace(/\\/g, '/').replace(/^([A-Z]):/, '/mnt/$1').toLowerCase();
      fullCommand = `wsl bash -c "cd ${wslPath} && source /opt/openfoam10/etc/bashrc && ${command}"`;
      shell = 'cmd.exe';
      shellArgs = ['/c', fullCommand];
    }
    
    console.log(`Executing: ${command}`);
    
    const process = spawn(shell, shellArgs, {
      cwd: casePath,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    
    let stdout = '';
    let stderr = '';
    
    process.stdout?.on('data', (data) => {
      stdout += data.toString();
    });
    
    process.stderr?.on('data', (data) => {
      stderr += data.toString();
    });
    
    process.on('close', (code) => {
      if (code === 0) {
        resolve(true);
      } else {
        console.error(`Command failed: ${command}`);
        console.error('stderr:', stderr);
        reject(new Error(`Command '${command}' failed with code ${code}: ${stderr}`));
      }
    });
    
    process.on('error', (err) => {
      reject(err);
    });
  });
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
    
    console.log(`Starting simulation ${simulationId}`);
    
    // Create case directory
    const casePath = await createCaseDirectory(simulationId);
    const resultsPath = path.join(SIMULATION_BASE_DIR, simulationId, 'results');
    
    // Update simulation with paths
    await Simulation.findByIdAndUpdate(simulationId, {
      casePath,
      resultsPath,
    });
    
    // Generate OpenFOAM case files
    await updateSimulationStatus(simulationId, 'meshing', 5, 'Generating case files...');
    await generateCaseFiles(casePath, room, configuration);
    
    if (SIMULATE_MODE) {
      // Generate mock results for testing without OpenFOAM
      await updateSimulationStatus(simulationId, 'running', 50, 'Simulating (mock mode)...');
      await new Promise(resolve => setTimeout(resolve, 2000)); // Simulate processing time
      
      await updateSimulationStatus(simulationId, 'postprocessing', 80, 'Generating mock results...');
      const results = await generateMockResults(resultsPath, room, configuration);
      
      await Simulation.findByIdAndUpdate(simulationId, {
        status: 'completed',
        progress: 100,
        statusMessage: 'Simulation completed (mock mode)',
        results,
        completedAt: new Date(),
      });
      
      console.log(`Simulation ${simulationId} completed (mock mode)`);
      return;
    }
    
    // Run OpenFOAM meshing
    await updateSimulationStatus(simulationId, 'meshing', 10, 'Running blockMesh...');
    await executeOpenFOAMCommand('blockMesh', casePath, simulationId, 'Generating base mesh...', 15);
    
    // Check if we need snappyHexMesh (for obstructions)
    if (configuration.obstructions && configuration.obstructions.length > 0) {
      await updateSimulationStatus(simulationId, 'meshing', 20, 'Running snappyHexMesh...');
      await executeOpenFOAMCommand('snappyHexMesh -overwrite', casePath, simulationId, 'Refining mesh around obstructions...', 35);
    }
    
    // Run the solver
    await updateSimulationStatus(simulationId, 'running', 40, 'Running simpleFoam solver...');
    await executeOpenFOAMCommand('simpleFoam', casePath, simulationId, 'Computing flow field...', 75);
    
    // Post-processing
    await updateSimulationStatus(simulationId, 'postprocessing', 80, 'Extracting results...');
    await executeOpenFOAMCommand('foamToVTK', casePath, simulationId, 'Converting to VTK format...', 85);
    
    // Process results
    await updateSimulationStatus(simulationId, 'postprocessing', 90, 'Processing visualization data...');
    const results = await processOpenFOAMResults(casePath, resultsPath, room, configuration);
    
    // Mark complete
    await Simulation.findByIdAndUpdate(simulationId, {
      status: 'completed',
      progress: 100,
      statusMessage: 'Simulation completed successfully',
      results,
      completedAt: new Date(),
    });
    
    console.log(`Simulation ${simulationId} completed successfully`);
    
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
