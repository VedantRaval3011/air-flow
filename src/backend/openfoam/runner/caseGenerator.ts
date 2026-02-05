/**
 * OpenFOAM Case File Generator - Main entry point
 */

import { mkdir } from 'fs/promises';
import path from 'path';
import { IRoomDocument } from '@/db/models/Room';
import { IConfigurationDocument } from '@/db/models/Configuration';
import { generateInitialConditions } from './initialConditions';
import { generateConstantFiles } from './constantFiles';
import { generateSystemFiles } from './systemFiles';
import { generateObstructionSTLs } from './stlGenerator';

/**
 * Generate all OpenFOAM case files
 */
export async function generateCaseFiles(
  casePath: string,
  room: IRoomDocument,
  config: IConfigurationDocument
): Promise<void> {
  // Create directory structure
  await mkdir(path.join(casePath, '0'), { recursive: true });
  await mkdir(path.join(casePath, 'constant', 'triSurface'), { recursive: true });
  await mkdir(path.join(casePath, 'system'), { recursive: true });
  
  // Generate files
  await Promise.all([
    generateInitialConditions(casePath, config),
    generateConstantFiles(casePath, config),
    generateSystemFiles(casePath, room, config),
  ]);
  
  // Generate STLs if obstructions exist
  if (config.obstructions && config.obstructions.length > 0) {
    await generateObstructionSTLs(casePath, config);
  }
}
