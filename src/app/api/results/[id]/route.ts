import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import connectToDatabase from '@/db/connection';
import Simulation from '@/db/models/Simulation';
import { IVisualizationData } from '@/types';

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/results/[id]
 * Get visualization data for a completed simulation
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
    
    const simulation = await Simulation.findById(id).lean();
    
    if (!simulation) {
      return NextResponse.json(
        { success: false, error: 'Simulation not found' },
        { status: 404 }
      );
    }
    
    if (simulation.status !== 'completed') {
      return NextResponse.json(
        { 
          success: false, 
          error: `Simulation is not complete. Current status: ${simulation.status}`,
          status: simulation.status,
          progress: simulation.progress,
        },
        { status: 400 }
      );
    }
    
    if (!simulation.results || !simulation.resultsPath) {
      return NextResponse.json(
        { success: false, error: 'No results available for this simulation' },
        { status: 404 }
      );
    }
    
    // Load visualization data from files
    const resultsDir = simulation.resultsPath;
    
    // Read streamlines data
    let streamlines = [];
    if (simulation.results.streamlines && existsSync(simulation.results.streamlines)) {
      const streamlinesData = await readFile(simulation.results.streamlines, 'utf-8');
      streamlines = JSON.parse(streamlinesData);
    }
    
    // Read velocity field data for vectors
    let velocityVectors = [];
    if (simulation.results.velocityField && existsSync(simulation.results.velocityField)) {
      const velocityData = await readFile(simulation.results.velocityField, 'utf-8');
      velocityVectors = JSON.parse(velocityData);
    }
    
    const visualizationData: IVisualizationData = {
      streamlines,
      velocityVectors,
      deadZones: simulation.results.deadZones || [],
      statistics: simulation.results.statistics,
      colorRange: {
        min: simulation.results.statistics?.minVelocity || 0,
        max: simulation.results.statistics?.maxVelocity || 1,
      },
    };
    
    return NextResponse.json({
      success: true,
      data: visualizationData,
    });
  } catch (error) {
    console.error('Error fetching results:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch visualization data' },
      { status: 500 }
    );
  }
}
