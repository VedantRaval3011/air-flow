/**
 * OpenFOAM System Files Generator
 * Generates system/ directory files
 */

import { writeFile } from 'fs/promises';
import path from 'path';
import { IRoomDocument } from '@/db/models/Room';
import { IConfigurationDocument } from '@/db/models/Configuration';

const FOAM_HEADER = `/*--------------------------------*- C++ -*----------------------------------*\\
| =========                 |                                                 |
| \\\\      /  F ield         | OpenFOAM: The Open Source CFD Toolbox           |
|  \\\\    /   O peration     | Version:  10                                    |
|   \\\\  /    A nd           | Website:  www.openfoam.org                      |
|    \\\\/     M anipulation  |                                                 |
\\*---------------------------------------------------------------------------*/`;

export async function generateSystemFiles(
  casePath: string,
  room: IRoomDocument,
  config: IConfigurationDocument
): Promise<void> {
  await Promise.all([
    generateBlockMeshDict(casePath, room),
    generateControlDict(casePath),
    generateFvSchemes(casePath),
    generateFvSolution(casePath),
  ]);
  
  if (config.obstructions && config.obstructions.length > 0) {
    await generateSnappyHexMeshDict(casePath, room, config);
  }
}

async function generateBlockMeshDict(casePath: string, room: IRoomDocument): Promise<void> {
  const { length, width, height } = room.dimensions;
  const cellSize = 0.1;
  const nx = Math.ceil(length / cellSize);
  const ny = Math.ceil(width / cellSize);
  const nz = Math.ceil(height / cellSize);

  const content = `${FOAM_HEADER}
FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      blockMeshDict;
}

scale 1;

vertices
(
    (0 0 0)
    (${length} 0 0)
    (${length} ${width} 0)
    (0 ${width} 0)
    (0 0 ${height})
    (${length} 0 ${height})
    (${length} ${width} ${height})
    (0 ${width} ${height})
);

blocks
(
    hex (0 1 2 3 4 5 6 7) (${nx} ${ny} ${nz}) simpleGrading (1 1 1)
);

edges ();

boundary
(
    floor { type wall; faces ((0 1 2 3)); }
    ceiling { type wall; faces ((4 5 6 7)); }
    walls
    {
        type wall;
        faces
        (
            (0 1 5 4)
            (2 3 7 6)
            (0 3 7 4)
            (1 2 6 5)
        );
    }
);
`;
  await writeFile(path.join(casePath, 'system', 'blockMeshDict'), content);
}

async function generateControlDict(casePath: string): Promise<void> {
  const content = `${FOAM_HEADER}
FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      controlDict;
}

application     simpleFoam;
startFrom       startTime;
startTime       0;
stopAt          endTime;
endTime         1000;
deltaT          1;
writeControl    timeStep;
writeInterval   100;
purgeWrite      3;
writeFormat     ascii;
writePrecision  6;
writeCompression off;
timeFormat      general;
timePrecision   6;
runTimeModifiable true;
`;
  await writeFile(path.join(casePath, 'system', 'controlDict'), content);
}

async function generateFvSchemes(casePath: string): Promise<void> {
  const content = `${FOAM_HEADER}
FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      fvSchemes;
}

ddtSchemes { default steadyState; }
gradSchemes { default Gauss linear; }
divSchemes
{
    default         none;
    div(phi,U)      bounded Gauss linearUpwind grad(U);
    div(phi,k)      bounded Gauss limitedLinear 1;
    div(phi,epsilon) bounded Gauss limitedLinear 1;
    div((nuEff*dev2(T(grad(U))))) Gauss linear;
}
laplacianSchemes { default Gauss linear corrected; }
interpolationSchemes { default linear; }
snGradSchemes { default corrected; }
`;
  await writeFile(path.join(casePath, 'system', 'fvSchemes'), content);
}

async function generateFvSolution(casePath: string): Promise<void> {
  const content = `${FOAM_HEADER}
FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      fvSolution;
}

solvers
{
    p { solver GAMG; tolerance 1e-06; relTol 0.1; smoother GaussSeidel; }
    "(U|k|epsilon)" { solver smoothSolver; smoother symGaussSeidel; tolerance 1e-05; relTol 0.1; }
}

SIMPLE
{
    nNonOrthogonalCorrectors 0;
    consistent yes;
    residualControl { p 1e-4; U 1e-4; "(k|epsilon)" 1e-4; }
}

relaxationFactors
{
    fields { p 0.3; }
    equations { U 0.7; k 0.7; epsilon 0.7; }
}
`;
  await writeFile(path.join(casePath, 'system', 'fvSolution'), content);
}

async function generateSnappyHexMeshDict(
  casePath: string,
  room: IRoomDocument,
  config: IConfigurationDocument
): Promise<void> {
  let geometries = '';
  let refinementSurfaces = '';
  
  config.obstructions.forEach((_, i) => {
    geometries += `
        obstruction_${i}.stl { type triSurfaceMesh; name obstruction_${i}; }`;
    refinementSurfaces += `
            obstruction_${i} { level (2 3); }`;
  });

  const content = `${FOAM_HEADER}
FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      snappyHexMeshDict;
}

castellatedMesh true;
snap true;
addLayers false;

geometry { ${geometries} }

castellatedMeshControls
{
    maxLocalCells 100000;
    maxGlobalCells 2000000;
    minRefinementCells 10;
    nCellsBetweenLevels 3;
    features ();
    refinementSurfaces { ${refinementSurfaces} }
    resolveFeatureAngle 30;
    refinementRegions {}
    locationInMesh (${room.dimensions.length/2} ${room.dimensions.width/2} ${room.dimensions.height/2});
    allowFreeStandingZoneFaces true;
}

snapControls { nSmoothPatch 3; tolerance 2.0; nSolveIter 30; nRelaxIter 5; }
addLayersControls { relativeSizes true; layers {} expansionRatio 1.0; finalLayerThickness 0.3; minThickness 0.1; }
meshQualityControls { maxNonOrtho 65; maxBoundarySkewness 20; maxConcave 80; minVol 1e-13; }
mergeTolerance 1e-6;
`;
  await writeFile(path.join(casePath, 'system', 'snappyHexMeshDict'), content);
}
