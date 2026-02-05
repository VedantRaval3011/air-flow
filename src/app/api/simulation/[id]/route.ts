import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import connectToDatabase from '@/db/connection';
import Simulation from '@/db/models/Simulation';
import Configuration from '@/db/models/Configuration';

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/simulation/[id]
 * Get a single simulation by ID with full details
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json(
        { success: false, error: 'Invalid simulation ID format' },
        { status: 400 }
      );
    }
    
    await connectToDatabase();
    
    const simulation = await Simulation.findById(id)
      .populate('roomId')
      .populate('configurationId')
      .lean();
    
    if (!simulation) {
      return NextResponse.json(
        { success: false, error: 'Simulation not found' },
        { status: 404 }
      );
    }
    
    return NextResponse.json({
      success: true,
      data: simulation,
    });
  } catch (error) {
    console.error('Error fetching simulation:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch simulation' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/simulation/[id]
 * Delete a simulation (only if not running)
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json(
        { success: false, error: 'Invalid simulation ID format' },
        { status: 400 }
      );
    }
    
    await connectToDatabase();
    
    // Check if simulation is running
    const simulation = await Simulation.findById(id);
    
    if (!simulation) {
      return NextResponse.json(
        { success: false, error: 'Simulation not found' },
        { status: 404 }
      );
    }
    
    if (['pending', 'meshing', 'running', 'postprocessing'].includes(simulation.status)) {
      return NextResponse.json(
        { success: false, error: 'Cannot delete a running simulation. Please wait for it to complete or fail.' },
        { status: 400 }
      );
    }
    
    // Delete the simulation
    await Simulation.findByIdAndDelete(id);
    
    // Optionally delete the configuration if no other simulations reference it
    const otherSimulations = await Simulation.countDocuments({
      configurationId: simulation.configurationId,
      _id: { $ne: id },
    });
    
    if (otherSimulations === 0) {
      await Configuration.findByIdAndDelete(simulation.configurationId);
    }
    
    return NextResponse.json({
      success: true,
      message: 'Simulation deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting simulation:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to delete simulation' },
      { status: 500 }
    );
  }
}
