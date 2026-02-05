/**
 * STL Generator for Obstructions
 * Generates STL geometry files for equipment, tables, humans, etc.
 */

import { writeFile } from 'fs/promises';
import path from 'path';
import { IConfigurationDocument } from '@/db/models/Configuration';
import { IObstruction } from '@/types';

export async function generateObstructionSTLs(
  casePath: string,
  config: IConfigurationDocument
): Promise<void> {
  const triSurfaceDir = path.join(casePath, 'constant', 'triSurface');
  
  for (let i = 0; i < config.obstructions.length; i++) {
    const obs = config.obstructions[i];
    const name = `obstruction_${i}`;
    
    let stlContent = '';
    
    if (obs.shape === 'cuboid' && obs.dimensions) {
      stlContent = generateCuboidSTL(name, obs.position, obs.dimensions);
    } else if (obs.shape === 'cylinder' && obs.radius && obs.height) {
      stlContent = generateCylinderSTL(name, obs.position, obs.radius, obs.height);
    } else if (obs.type === 'human') {
      stlContent = generateHumanSTL(name, obs);
    }
    
    if (stlContent) {
      await writeFile(path.join(triSurfaceDir, `${name}.stl`), stlContent);
    }
  }
}

function generateCuboidSTL(
  name: string,
  pos: { x: number; y: number; z: number },
  dim: { width?: number; height?: number; depth?: number }
): string {
  const w = dim.width || 1;
  const h = dim.height || 1;
  const d = dim.depth || 1;
  
  const vertices = [
    [pos.x - w/2, pos.y - d/2, pos.z],
    [pos.x + w/2, pos.y - d/2, pos.z],
    [pos.x + w/2, pos.y + d/2, pos.z],
    [pos.x - w/2, pos.y + d/2, pos.z],
    [pos.x - w/2, pos.y - d/2, pos.z + h],
    [pos.x + w/2, pos.y - d/2, pos.z + h],
    [pos.x + w/2, pos.y + d/2, pos.z + h],
    [pos.x - w/2, pos.y + d/2, pos.z + h],
  ];
  
  const faces = [
    [0,2,1], [0,3,2], [4,5,6], [4,6,7],
    [0,1,5], [0,5,4], [2,3,7], [2,7,6],
    [0,4,7], [0,7,3], [1,2,6], [1,6,5],
  ];
  
  return buildSTL(name, vertices, faces);
}

function generateCylinderSTL(
  name: string,
  pos: { x: number; y: number; z: number },
  radius: number,
  height: number,
  segments: number = 24
): string {
  let stl = `solid ${name}\n`;
  
  for (let i = 0; i < segments; i++) {
    const a1 = (i / segments) * 2 * Math.PI;
    const a2 = ((i + 1) / segments) * 2 * Math.PI;
    
    const x1 = pos.x + radius * Math.cos(a1);
    const y1 = pos.y + radius * Math.sin(a1);
    const x2 = pos.x + radius * Math.cos(a2);
    const y2 = pos.y + radius * Math.sin(a2);
    
    // Side faces
    stl += facet([x1, y1, pos.z], [x2, y2, pos.z], [x2, y2, pos.z + height]);
    stl += facet([x1, y1, pos.z], [x2, y2, pos.z + height], [x1, y1, pos.z + height]);
    // Caps
    stl += facet([pos.x, pos.y, pos.z], [x2, y2, pos.z], [x1, y1, pos.z]);
    stl += facet([pos.x, pos.y, pos.z + height], [x1, y1, pos.z + height], [x2, y2, pos.z + height]);
  }
  
  stl += `endsolid ${name}\n`;
  return stl;
}

function generateHumanSTL(name: string, obs: IObstruction): string {
  // Simplified human as capsule (cylinder + hemisphere top)
  const height = obs.humanPosture === 'sitting' ? 1.2 : 1.7;
  const radius = 0.25;
  return generateCylinderSTL(name, obs.position, radius, height, 16);
}

function buildSTL(name: string, vertices: number[][], faces: number[][]): string {
  let stl = `solid ${name}\n`;
  
  for (const f of faces) {
    const p1 = vertices[f[0]];
    const p2 = vertices[f[1]];
    const p3 = vertices[f[2]];
    stl += facet(p1, p2, p3);
  }
  
  stl += `endsolid ${name}\n`;
  return stl;
}

function facet(p1: number[], p2: number[], p3: number[]): string {
  // Calculate normal
  const ax = p2[0]-p1[0], ay = p2[1]-p1[1], az = p2[2]-p1[2];
  const bx = p3[0]-p1[0], by = p3[1]-p1[1], bz = p3[2]-p1[2];
  const nx = ay*bz - az*by, ny = az*bx - ax*bz, nz = ax*by - ay*bx;
  const len = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1;
  
  return `  facet normal ${(nx/len).toFixed(6)} ${(ny/len).toFixed(6)} ${(nz/len).toFixed(6)}
    outer loop
      vertex ${p1[0].toFixed(6)} ${p1[1].toFixed(6)} ${p1[2].toFixed(6)}
      vertex ${p2[0].toFixed(6)} ${p2[1].toFixed(6)} ${p2[2].toFixed(6)}
      vertex ${p3[0].toFixed(6)} ${p3[1].toFixed(6)} ${p3[2].toFixed(6)}
    endloop
  endfacet
`;
}
