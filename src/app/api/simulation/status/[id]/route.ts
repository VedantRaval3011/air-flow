import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import connectToDatabase from '@/db/connection';
import Simulation from '@/db/models/Simulation';
import { SimulationStatusResponse } from '@/types';

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/simulation/status/[id]
 * Get simulation status and progress (lightweight endpoint for polling)
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
      .select('status progress statusMessage results error completedAt')
      .lean();
    
    if (!simulation) {
      return NextResponse.json(
        { success: false, error: 'Simulation not found' },
        { status: 404 }
      );
    }
    
    const response: SimulationStatusResponse = {
      status: simulation.status,
      progress: simulation.progress,
      message: simulation.error || simulation.statusMessage || '',
      results: simulation.status === 'completed' ? simulation.results : undefined,
    };
    
    return NextResponse.json({
      success: true,
      data: response,
    });
  } catch (error) {
    console.error('Error fetching simulation status:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch simulation status' },
      { status: 500 }
    );
  }
}
