/**
 * OpenFOAM Initial Conditions Generator
 * Generates 0/ directory files (U, p, k, epsilon, nut)
 */

import { writeFile } from 'fs/promises';
import path from 'path';
import { IConfigurationDocument } from '@/db/models/Configuration';
import { 
  calculateDiffuserVelocity,
  estimateTurbulentKineticEnergy,
  estimateTurbulentDissipation
} from '@/lib/physics/airflowCalculations';

const FOAM_HEADER = `/*--------------------------------*- C++ -*----------------------------------*\\
| =========                 |                                                 |
| \\\\      /  F ield         | OpenFOAM: The Open Source CFD Toolbox           |
|  \\\\    /   O peration     | Version:  10                                    |
|   \\\\  /    A nd           | Website:  www.openfoam.org                      |
|    \\\\/     M anipulation  |                                                 |
\\*---------------------------------------------------------------------------*/`;

export async function generateInitialConditions(
  casePath: string,
  config: IConfigurationDocument
): Promise<void> {
  await Promise.all([
    generateVelocityFile(casePath, config),
    generatePressureFile(casePath, config),
    generateKFile(casePath, config),
    generateEpsilonFile(casePath, config),
    generateNutFile(casePath, config),
  ]);
}

async function generateVelocityFile(casePath: string, config: IConfigurationDocument): Promise<void> {
  let inletBCs = '';
  config.supplyDiffusers.forEach((d, i) => {
    const vel = calculateDiffuserVelocity(d);
    inletBCs += `
    inlet_${i}
    {
        type            fixedValue;
        value           uniform (0 0 -${vel.toFixed(4)});
    }`;
  });

  let outletBCs = '';
  config.returnGrills.forEach((_, i) => {
    outletBCs += `
    outlet_${i}
    {
        type            zeroGradient;
    }`;
  });

  const content = `${FOAM_HEADER}
FoamFile
{
    version     2.0;
    format      ascii;
    class       volVectorField;
    object      U;
}

dimensions      [0 1 -1 0 0 0 0];
internalField   uniform (0 0 0);

boundaryField
{
    walls { type noSlip; }
    floor { type noSlip; }
    ceiling { type noSlip; }
${inletBCs}
${outletBCs}
}
`;
  await writeFile(path.join(casePath, '0', 'U'), content);
}

async function generatePressureFile(casePath: string, config: IConfigurationDocument): Promise<void> {
  let inletBCs = '';
  config.supplyDiffusers.forEach((_, i) => {
    inletBCs += `
    inlet_${i} { type zeroGradient; }`;
  });

  let outletBCs = '';
  config.returnGrills.forEach((_, i) => {
    outletBCs += `
    outlet_${i} { type fixedValue; value uniform 0; }`;
  });

  const content = `${FOAM_HEADER}
FoamFile
{
    version     2.0;
    format      ascii;
    class       volScalarField;
    object      p;
}

dimensions      [0 2 -2 0 0 0 0];
internalField   uniform 0;

boundaryField
{
    walls { type zeroGradient; }
    floor { type zeroGradient; }
    ceiling { type zeroGradient; }
${inletBCs}
${outletBCs}
}
`;
  await writeFile(path.join(casePath, '0', 'p'), content);
}

async function generateKFile(casePath: string, config: IConfigurationDocument): Promise<void> {
  const avgVel = config.supplyDiffusers.reduce((sum, d) => sum + calculateDiffuserVelocity(d), 0) / config.supplyDiffusers.length;
  const k = estimateTurbulentKineticEnergy(avgVel, 0.05);

  let inletBCs = '';
  config.supplyDiffusers.forEach((d, i) => {
    const kVal = estimateTurbulentKineticEnergy(calculateDiffuserVelocity(d), 0.05);
    inletBCs += `
    inlet_${i} { type fixedValue; value uniform ${kVal.toFixed(6)}; }`;
  });

  let outletBCs = '';
  config.returnGrills.forEach((_, i) => {
    outletBCs += `
    outlet_${i} { type zeroGradient; }`;
  });

  const content = `${FOAM_HEADER}
FoamFile
{
    version     2.0;
    format      ascii;
    class       volScalarField;
    object      k;
}

dimensions      [0 2 -2 0 0 0 0];
internalField   uniform ${(k * 0.1).toFixed(6)};

boundaryField
{
    walls { type kqRWallFunction; value uniform ${(k * 0.01).toFixed(6)}; }
    floor { type kqRWallFunction; value uniform ${(k * 0.01).toFixed(6)}; }
    ceiling { type kqRWallFunction; value uniform ${(k * 0.01).toFixed(6)}; }
${inletBCs}
${outletBCs}
}
`;
  await writeFile(path.join(casePath, '0', 'k'), content);
}

async function generateEpsilonFile(casePath: string, config: IConfigurationDocument): Promise<void> {
  const avgVel = config.supplyDiffusers.reduce((sum, d) => sum + calculateDiffuserVelocity(d), 0) / config.supplyDiffusers.length;
  const k = estimateTurbulentKineticEnergy(avgVel, 0.05);
  const eps = estimateTurbulentDissipation(k, 0.1);

  let inletBCs = '';
  config.supplyDiffusers.forEach((d, i) => {
    const kVal = estimateTurbulentKineticEnergy(calculateDiffuserVelocity(d), 0.05);
    const epsVal = estimateTurbulentDissipation(kVal, 0.1);
    inletBCs += `
    inlet_${i} { type fixedValue; value uniform ${epsVal.toFixed(6)}; }`;
  });

  let outletBCs = '';
  config.returnGrills.forEach((_, i) => {
    outletBCs += `
    outlet_${i} { type zeroGradient; }`;
  });

  const content = `${FOAM_HEADER}
FoamFile
{
    version     2.0;
    format      ascii;
    class       volScalarField;
    object      epsilon;
}

dimensions      [0 2 -3 0 0 0 0];
internalField   uniform ${(eps * 0.1).toFixed(6)};

boundaryField
{
    walls { type epsilonWallFunction; value uniform ${(eps * 0.01).toFixed(6)}; }
    floor { type epsilonWallFunction; value uniform ${(eps * 0.01).toFixed(6)}; }
    ceiling { type epsilonWallFunction; value uniform ${(eps * 0.01).toFixed(6)}; }
${inletBCs}
${outletBCs}
}
`;
  await writeFile(path.join(casePath, '0', 'epsilon'), content);
}

async function generateNutFile(casePath: string, config: IConfigurationDocument): Promise<void> {
  const content = `${FOAM_HEADER}
FoamFile
{
    version     2.0;
    format      ascii;
    class       volScalarField;
    object      nut;
}

dimensions      [0 2 -1 0 0 0 0];
internalField   uniform 0;

boundaryField
{
    "(walls|floor|ceiling)" { type nutkWallFunction; value uniform 0; }
    "(inlet_.*|outlet_.*)" { type calculated; value uniform 0; }
}
`;
  await writeFile(path.join(casePath, '0', 'nut'), content);
}
