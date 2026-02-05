/**
 * OpenFOAM Constant Files Generator
 * Generates constant/ directory files
 */

import { writeFile } from 'fs/promises';
import path from 'path';
import { IConfigurationDocument } from '@/db/models/Configuration';

const FOAM_HEADER = `/*--------------------------------*- C++ -*----------------------------------*\\
| =========                 |                                                 |
| \\\\      /  F ield         | OpenFOAM: The Open Source CFD Toolbox           |
|  \\\\    /   O peration     | Version:  10                                    |
|   \\\\  /    A nd           | Website:  www.openfoam.org                      |
|    \\\\/     M anipulation  |                                                 |
\\*---------------------------------------------------------------------------*/`;

export async function generateConstantFiles(
  casePath: string,
  config: IConfigurationDocument
): Promise<void> {
  await Promise.all([
    generateTransportProperties(casePath, config),
    generateTurbulenceProperties(casePath),
  ]);
}

async function generateTransportProperties(casePath: string, config: IConfigurationDocument): Promise<void> {
  const nu = 1.5e-5; // Kinematic viscosity of air at 20°C

  const content = `${FOAM_HEADER}
FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      transportProperties;
}

// Air at ${config.airflowParams.temperature || 293.15}K
transportModel  Newtonian;
nu              [0 2 -1 0 0 0 0] ${nu};
`;
  await writeFile(path.join(casePath, 'constant', 'transportProperties'), content);
}

async function generateTurbulenceProperties(casePath: string): Promise<void> {
  const content = `${FOAM_HEADER}
FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      turbulenceProperties;
}

simulationType  RAS;

RAS
{
    RASModel        kEpsilon;
    turbulence      on;
    printCoeffs     on;
}
`;
  await writeFile(path.join(casePath, 'constant', 'turbulenceProperties'), content);
}
