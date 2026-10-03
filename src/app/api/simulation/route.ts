import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import connectToDatabase from '@/db/connection';
import Room from '@/db/models/Room';
import Configuration from '@/db/models/Configuration';
import Simulation from '@/db/models/Simulation';
import { generateConfigHash, ConfigHashInput } from '@/lib/hash/configHash';
import { calculateDiffuserVelocity } from '@/lib/physics/airflowCalculations';
import { CreateSimulationRequest, SimulationTriggerResponse } from '@/types';

/**
 * POST /api/simulation
 * Trigger a new simulation or return existing one if config matches
 */
export async function POST(request: NextRequest) {
  try {
    await connectToDatabase();
    
    const body: CreateSimulationRequest = await request.json();
    
    // Validate required fields
    if (!body.roomId || !body.supplyDiffusers || !body.returnGrills || !body.airflowParams) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields: roomId, supplyDiffusers, returnGrills, airflowParams' },
        { status: 400 }
      );
    }
    
    // Validate arrays
    if (body.supplyDiffusers.length === 0) {
      return NextResponse.json(
        { success: false, error: 'At least one supply diffuser is required' },
        { status: 400 }
      );
    }
    
    if (body.returnGrills.length === 0) {
      return NextResponse.json(
        { success: false, error: 'At least one return grill is required' },
        { status: 400 }
      );
    }
    
    // Fetch room to validate and get dimensions
    const room = await Room.findById(body.roomId);
    if (!room) {
      return NextResponse.json(
        { success: false, error: 'Room not found' },
        { status: 404 }
      );
    }
    
    // Calculate velocities for each diffuser
    const diffusersWithVelocity = body.supplyDiffusers.map(d => ({
      ...d,
      id: d.id || uuidv4(),
      calculatedVelocity: calculateDiffuserVelocity(d),
    }));
    
    // Ensure all grills and obstructions have IDs
    const grillsWithIds = body.returnGrills.map(g => ({
      ...g,
      id: g.id || uuidv4(),
    }));
    
    const obstructionsWithIds = (body.obstructions || []).map(o => ({
      ...o,
      id: o.id || uuidv4(),
    }));
    
    // Generate configuration hash for deduplication
    const hashInput: ConfigHashInput = {
      roomId: body.roomId,
      roomLength: room.dimensions.length,
      roomWidth: room.dimensions.width,
      roomHeight: room.dimensions.height,
      supplyDiffusers: diffusersWithVelocity,
      returnGrills: grillsWithIds,
      obstructions: obstructionsWithIds,
      airflowParams: body.airflowParams,
    };
    
    const configHash = generateConfigHash(hashInput);
    
    // Check if a completed simulation with this hash already exists
    const existingSimulation = await Simulation.findOne({
      configHash,
      status: 'completed',
    }).sort({ completedAt: -1 });
    
    if (existingSimulation) {
      // Reuse existing simulation
      const response: SimulationTriggerResponse = {
        simulationId: existingSimulation._id.toString(),
        reused: true,
        status: 'completed',
        message: 'Existing simulation found with matching configuration. Results ready.',
      };
      
      return NextResponse.json({
        success: true,
        data: response,
      });
    }
    
    // Check if there's a running simulation with this hash. A record left
    // in-progress by a crashed or restarted server would otherwise block this
    // configuration forever, so anything older than the stale window is
    // retired and the simulation is started again.
    const runningSimulation = await Simulation.findOne({
      configHash,
      status: { $in: ['pending', 'meshing', 'running', 'postprocessing'] },
    });

    if (runningSimulation && isStale(runningSimulation)) {
      await Simulation.findByIdAndUpdate(runningSimulation._id, {
        status: 'failed',
        progress: 0,
        statusMessage: undefined,
        error: 'Simulation was interrupted before it finished (stale run retired).',
        completedAt: new Date(),
      });
    } else if (runningSimulation) {
      const response: SimulationTriggerResponse = {
        simulationId: runningSimulation._id.toString(),
        reused: true,
        status: runningSimulation.status,
        message: 'Simulation with this configuration is already in progress.',
      };
      
      return NextResponse.json({
        success: true,
        data: response,
      });
    }
    
    // Reuse the configuration document if this exact setup has been submitted
    // before (configHash is unique). Without this, re-running a configuration
    // whose earlier simulation failed would be rejected as a duplicate key and
    // the user could never retry it.
    const configuration =
      (await Configuration.findOne({ configHash })) ??
      (await Configuration.create({
        roomId: body.roomId,
        configHash,
        supplyDiffusers: diffusersWithVelocity,
        returnGrills: grillsWithIds,
        obstructions: obstructionsWithIds,
        airflowParams: body.airflowParams,
      }));
    
    // Create new simulation record
    const simulation = await Simulation.create({
      configurationId: configuration._id,
      configHash,
      roomId: body.roomId,
      status: 'pending',
      progress: 0,
      statusMessage: 'Simulation queued for processing',
    });
    
    // In a production system, we would queue this to a job system (Bull, etc.)
    // For now, we'll trigger the simulation runner asynchronously
    // Note: This is a simplified implementation. In production, use a proper job queue.
    triggerSimulationAsync(simulation._id.toString(), configuration._id.toString());
    
    const response: SimulationTriggerResponse = {
      simulationId: simulation._id.toString(),
      reused: false,
      status: 'pending',
      message: 'New simulation created and queued for processing.',
    };
    
    return NextResponse.json({
      success: true,
      data: response,
    }, { status: 201 });
    
  } catch (error) {
    console.error('Error creating simulation:', error);
    
    // Handle duplicate config hash error
    if (error instanceof Error && error.message.includes('duplicate key')) {
      return NextResponse.json(
        { success: false, error: 'Configuration already exists' },
        { status: 409 }
      );
    }
    
    return NextResponse.json(
      { success: false, error: 'Failed to create simulation' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/simulation
 * List all simulations
 */
export async function GET(request: NextRequest) {
  try {
    await connectToDatabase();
    
    const { searchParams } = new URL(request.url);
    const roomId = searchParams.get('roomId');
    const status = searchParams.get('status');
    
    // Build query
    const query: Record<string, unknown> = {};
    if (roomId) query.roomId = roomId;
    if (status) query.status = status;
    
    const simulations = await Simulation.find(query)
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    
    return NextResponse.json({
      success: true,
      data: simulations,
      count: simulations.length,
    });
  } catch (error) {
    console.error('Error fetching simulations:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch simulations' },
      { status: 500 }
    );
  }
}

/** How long an in-progress simulation may go without an update before it is
 * considered abandoned. The solver reports progress every few seconds, so a
 * live run refreshes `updatedAt` well inside this window. */
const STALE_AFTER_MS = 10 * 60 * 1000;

function isStale(simulation: { updatedAt?: Date; createdAt?: Date }): boolean {
  const lastTouched = simulation.updatedAt ?? simulation.createdAt;
  if (!lastTouched) return true;
  return Date.now() - new Date(lastTouched).getTime() > STALE_AFTER_MS;
}

/**
 * Trigger simulation asynchronously
 * In production, this should be replaced with a proper job queue
 */
async function triggerSimulationAsync(simulationId: string, configurationId: string) {
  // Dynamic import to avoid module resolution issues on startup
  try {
    const { runSimulation } = await import('@/backend/openfoam/runner/simulationRunner');
    runSimulation(simulationId, configurationId).catch(error => {
      console.error('Simulation failed:', error);
    });
  } catch (error) {
    console.error('Failed to import simulation runner:', error);
    // Update simulation status to failed
    await Simulation.findByIdAndUpdate(simulationId, {
      status: 'failed',
      error: 'Failed to start simulation runner',
    });
  }
}
