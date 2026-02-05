/**
 * Configuration Hash Service
 * Generates deterministic hashes for simulation configurations
 * Used to prevent duplicate simulations with identical parameters
 */

import CryptoJS from 'crypto-js';
import { 
  ISupplyDiffuser, 
  IReturnGrill, 
  IObstruction, 
  IAirflowParams 
} from '@/types';

/**
 * Normalize a number to a fixed precision to avoid floating point comparison issues
 */
function normalizeNumber(num: number, precision: number = 6): number {
  return parseFloat(num.toFixed(precision));
}

/**
 * Normalize a vector3D for hashing
 */
function normalizeVector(v: { x: number; y: number; z: number }): object {
  return {
    x: normalizeNumber(v.x),
    y: normalizeNumber(v.y),
    z: normalizeNumber(v.z),
  };
}

/**
 * Normalize supply diffuser for hashing (exclude volatile fields like 'id')
 */
function normalizeDiffuser(d: ISupplyDiffuser): object {
  return {
    position: normalizeVector(d.position),
    size: {
      width: normalizeNumber(d.size.width),
      height: normalizeNumber(d.size.height),
    },
    flowType: d.flowType,
    flowRate: d.flowRate ? normalizeNumber(d.flowRate) : null,
    fanRPM: d.fanRPM ? normalizeNumber(d.fanRPM) : null,
    fanDiameter: d.fanDiameter ? normalizeNumber(d.fanDiameter) : 0.3,
  };
}

/**
 * Normalize return grill for hashing
 */
function normalizeGrill(g: IReturnGrill): object {
  return {
    position: normalizeVector(g.position),
    size: {
      width: normalizeNumber(g.size.width),
      height: normalizeNumber(g.size.height),
    },
  };
}

/**
 * Normalize obstruction for hashing
 */
function normalizeObstruction(o: IObstruction): object {
  return {
    type: o.type,
    shape: o.shape,
    position: normalizeVector(o.position),
    dimensions: o.dimensions ? {
      width: normalizeNumber(o.dimensions.width || 0),
      height: normalizeNumber(o.dimensions.height || 0),
      depth: normalizeNumber(o.dimensions.depth || 0),
    } : null,
    radius: o.radius ? normalizeNumber(o.radius) : null,
    height: o.height ? normalizeNumber(o.height) : null,
    humanPosture: o.humanPosture || null,
  };
}

/**
 * Normalize airflow parameters for hashing
 */
function normalizeParams(p: IAirflowParams): object {
  return {
    targetACH: normalizeNumber(p.targetACH),
    temperature: p.temperature ? normalizeNumber(p.temperature) : 293.15,
    pressure: p.pressure ? normalizeNumber(p.pressure) : 101325,
  };
}

/**
 * Sort array of objects by a deterministic key for consistent hashing
 */
function sortByPosition<T extends { position: { x: number; y: number; z: number } }>(
  arr: T[]
): T[] {
  return [...arr].sort((a, b) => {
    if (a.position.x !== b.position.x) return a.position.x - b.position.x;
    if (a.position.y !== b.position.y) return a.position.y - b.position.y;
    return a.position.z - b.position.z;
  });
}

export interface ConfigHashInput {
  roomId: string;
  roomLength: number;
  roomWidth: number;
  roomHeight: number;
  supplyDiffusers: ISupplyDiffuser[];
  returnGrills: IReturnGrill[];
  obstructions: IObstruction[];
  airflowParams: IAirflowParams;
}

/**
 * Generate a deterministic SHA-256 hash for a simulation configuration
 * 
 * The hash includes:
 * - Room ID and dimensions
 * - All supply diffusers (position, size, flow settings)
 * - All return grills (position, size)
 * - All obstructions (type, shape, position, dimensions)
 * - Airflow parameters (ACH, temperature, pressure)
 * 
 * The hash excludes:
 * - Object IDs (volatile)
 * - Names (cosmetic)
 * - Timestamps
 * 
 * @param config - Configuration input
 * @returns SHA-256 hash string
 */
export function generateConfigHash(config: ConfigHashInput): string {
  // Sort arrays to ensure consistent ordering
  const sortedDiffusers = sortByPosition(config.supplyDiffusers);
  const sortedGrills = sortByPosition(config.returnGrills);
  const sortedObstructions = sortByPosition(config.obstructions);

  // Build normalized hash input
  const hashInput = {
    room: {
      id: config.roomId,
      length: normalizeNumber(config.roomLength),
      width: normalizeNumber(config.roomWidth),
      height: normalizeNumber(config.roomHeight),
    },
    supplies: sortedDiffusers.map(normalizeDiffuser),
    returns: sortedGrills.map(normalizeGrill),
    obstructions: sortedObstructions.map(normalizeObstruction),
    params: normalizeParams(config.airflowParams),
  };

  // Generate hash
  const jsonString = JSON.stringify(hashInput);
  return CryptoJS.SHA256(jsonString).toString();
}

/**
 * Check if two configuration hashes are equal
 */
export function compareConfigHashes(hash1: string, hash2: string): boolean {
  return hash1 === hash2;
}

/**
 * Generate a short hash (first 12 characters) for display purposes
 */
export function shortHash(fullHash: string): string {
  return fullHash.substring(0, 12);
}
