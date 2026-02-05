/**
 * OpenFOAM Result Processor
 * Converts OpenFOAM output to JSON for Three.js visualization
 */

import { mkdir, writeFile, readdir, readFile } from 'fs/promises';
import path from 'path';
import { IRoomDocument } from '@/db/models/Room';
import { IConfigurationDocument } from '@/db/models/Configuration';
import { 
  ISimulationResults, 
  IStreamline, 
  IVelocityVector,
  IDeadZone,
  ISimulationStatistics,
  Vector3D
} from '@/types';

const DEAD_ZONE_THRESHOLD = 0.05; // m/s - below this is considered a dead zone

/**
 * Process OpenFOAM results into visualization-ready JSON
 */
export async function processOpenFOAMResults(
  casePath: string,
  resultsPath: string,
  room: IRoomDocument,
  config: IConfigurationDocument
): Promise<ISimulationResults> {
  // Find the latest time directory
  const timeDir = await findLatestTimeDir(casePath);
  
  // Read velocity and pressure fields
  const velocityData = await parseVelocityField(path.join(casePath, timeDir, 'U'));
  const pressureData = await parsePressureField(path.join(casePath, timeDir, 'p'));
  
  // Generate streamlines
  const streamlines = generateStreamlines(velocityData, room, config);
  
  // Identify dead zones
  const deadZones = identifyDeadZones(velocityData, room);
  
  // Calculate statistics
  const statistics = calculateStatistics(velocityData, pressureData);
  
  // Sample velocity vectors for visualization
  const velocityVectors = sampleVelocityVectors(velocityData, room, 1000);
  
  // Save to files
  const streamlinesPath = path.join(resultsPath, 'streamlines.json');
  const velocityPath = path.join(resultsPath, 'velocity.json');
  const pressurePath = path.join(resultsPath, 'pressure.json');
  
  await writeFile(streamlinesPath, JSON.stringify(streamlines));
  await writeFile(velocityPath, JSON.stringify(velocityVectors));
  await writeFile(pressurePath, JSON.stringify(pressureData));
  
  return {
    velocityField: velocityPath,
    pressureField: pressurePath,
    streamlines: streamlinesPath,
    deadZones,
    statistics,
  };
}

/**
 * Generate mock results for development without OpenFOAM
 */
export async function generateMockResults(
  resultsPath: string,
  room: IRoomDocument,
  config: IConfigurationDocument
): Promise<ISimulationResults> {
  const { length, width, height } = room.dimensions;
  
  // Generate mock streamlines from supply diffusers
  const streamlines: IStreamline[] = [];
  
  config.supplyDiffusers.forEach((diffuser, idx) => {
    // Create multiple streamlines per diffuser
    for (let i = 0; i < 10; i++) {
      const offsetX = (Math.random() - 0.5) * diffuser.size.width * 0.8;
      const offsetY = (Math.random() - 0.5) * diffuser.size.height * 0.8;
      
      const points: Vector3D[] = [];
      const velocities: number[] = [];
      
      let x = diffuser.position.x + offsetX;
      let y = diffuser.position.y + offsetY;
      let z = diffuser.position.z;
      let vel = diffuser.calculatedVelocity || 2;
      
      // Simulate particle path
      for (let step = 0; step < 50; step++) {
        points.push({ x, y, z });
        velocities.push(vel);
        
        // Move downward with some spreading and deceleration
        z -= 0.1;
        x += (Math.random() - 0.5) * 0.05;
        y += (Math.random() - 0.5) * 0.05;
        vel *= 0.95;
        
        // Stop at floor
        if (z <= 0.1) {
          // Flow along floor toward returns
          for (let floorStep = 0; floorStep < 20; floorStep++) {
            const nearestReturn = findNearestReturn(x, y, config);
            const dx = nearestReturn.x - x;
            const dy = nearestReturn.y - y;
            const dist = Math.sqrt(dx*dx + dy*dy);
            
            if (dist < 0.5) break;
            
            x += (dx / dist) * 0.15;
            y += (dy / dist) * 0.15;
            z = 0.1 + Math.random() * 0.1;
            vel = 0.3 + Math.random() * 0.2;
            
            points.push({ x, y, z });
            velocities.push(vel);
          }
          break;
        }
      }
      
      streamlines.push({
        id: `streamline_${idx}_${i}`,
        points,
        velocities,
      });
    }
  });
  
  // Generate velocity vectors grid
  const velocityVectors: IVelocityVector[] = [];
  const gridStep = 0.5;
  
  for (let x = gridStep; x < length; x += gridStep) {
    for (let y = gridStep; y < width; y += gridStep) {
      for (let z = gridStep; z < height; z += gridStep) {
        // Simple downward flow with some randomness
        const distFromCeiling = height - z;
        const magnitude = Math.max(0.1, 2 - distFromCeiling * 0.3 + Math.random() * 0.2);
        
        velocityVectors.push({
          position: { x, y, z },
          direction: { x: (Math.random()-0.5)*0.1, y: (Math.random()-0.5)*0.1, z: -0.9 },
          magnitude,
        });
      }
    }
  }
  
  // Identify dead zones (corners and behind obstructions)
  const deadZones: IDeadZone[] = [
    { position: { x: 0.5, y: 0.5, z: 0.5 }, volume: 0.5, velocityMagnitude: 0.02 },
    { position: { x: length-0.5, y: 0.5, z: 0.5 }, volume: 0.5, velocityMagnitude: 0.03 },
    { position: { x: 0.5, y: width-0.5, z: 0.5 }, volume: 0.4, velocityMagnitude: 0.02 },
    { position: { x: length-0.5, y: width-0.5, z: 0.5 }, volume: 0.6, velocityMagnitude: 0.01 },
  ];
  
  // Add dead zones behind obstructions
  config.obstructions.forEach((obs, i) => {
    deadZones.push({
      position: { 
        x: obs.position.x, 
        y: obs.position.y + (obs.dimensions?.depth || 0.5) + 0.3, 
        z: obs.position.z + 0.5 
      },
      volume: 0.3,
      velocityMagnitude: 0.03,
    });
  });
  
  const statistics: ISimulationStatistics = {
    maxVelocity: 3.2,
    avgVelocity: 0.8,
    minVelocity: 0.01,
    minPressure: -5,
    maxPressure: 10,
    avgPressure: 0,
  };
  
  // Save to files
  const streamlinesPath = path.join(resultsPath, 'streamlines.json');
  const velocityPath = path.join(resultsPath, 'velocity.json');
  const pressurePath = path.join(resultsPath, 'pressure.json');
  
  await writeFile(streamlinesPath, JSON.stringify(streamlines));
  await writeFile(velocityPath, JSON.stringify(velocityVectors));
  await writeFile(pressurePath, JSON.stringify({ field: 'mock' }));
  
  return {
    velocityField: velocityPath,
    pressureField: pressurePath,
    streamlines: streamlinesPath,
    deadZones,
    statistics,
  };
}

function findNearestReturn(x: number, y: number, config: IConfigurationDocument): Vector3D {
  let nearest = config.returnGrills[0]?.position || { x: 0, y: 0, z: 0 };
  let minDist = Infinity;
  
  for (const grill of config.returnGrills) {
    const dx = grill.position.x - x;
    const dy = grill.position.y - y;
    const dist = dx*dx + dy*dy;
    if (dist < minDist) {
      minDist = dist;
      nearest = grill.position;
    }
  }
  
  return nearest;
}

// Helper functions for real OpenFOAM processing (stubs for now)
async function findLatestTimeDir(casePath: string): Promise<string> {
  try {
    const files = await readdir(casePath);
    const timeDirectories = files.filter(f => /^\d+$/.test(f) || /^\d+\.\d+$/.test(f));
    timeDirectories.sort((a, b) => parseFloat(b) - parseFloat(a));
    return timeDirectories[0] || '0';
  } catch {
    return '0';
  }
}

async function parseVelocityField(filePath: string): Promise<IVelocityVector[]> {
  // Stub - in production, parse OpenFOAM's U file
  return [];
}

async function parsePressureField(filePath: string): Promise<number[]> {
  // Stub - in production, parse OpenFOAM's p file
  return [];
}

function generateStreamlines(
  velocityData: IVelocityVector[],
  room: IRoomDocument,
  config: IConfigurationDocument
): IStreamline[] {
  // Stub - in production, trace streamlines through velocity field
  return [];
}

function identifyDeadZones(
  velocityData: IVelocityVector[],
  room: IRoomDocument
): IDeadZone[] {
  // Stub - in production, identify regions with velocity below threshold
  return [];
}

function calculateStatistics(
  velocityData: IVelocityVector[],
  pressureData: number[]
): ISimulationStatistics {
  // Stub - calculate statistics from actual data
  return {
    maxVelocity: 0,
    avgVelocity: 0,
    minVelocity: 0,
    minPressure: 0,
    maxPressure: 0,
    avgPressure: 0,
  };
}

function sampleVelocityVectors(
  velocityData: IVelocityVector[],
  room: IRoomDocument,
  count: number
): IVelocityVector[] {
  // Stub - downsample for visualization
  return velocityData.slice(0, count);
}
