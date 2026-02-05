import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import connectToDatabase from '@/db/connection';
import Room from '@/db/models/Room';
import { IRoom } from '@/types';

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/room/[id]
 * Get a single room by ID
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json(
        { success: false, error: 'Invalid room ID format' },
        { status: 400 }
      );
    }
    
    await connectToDatabase();
    
    const room = await Room.findById(id).lean();
    
    if (!room) {
      return NextResponse.json(
        { success: false, error: 'Room not found' },
        { status: 404 }
      );
    }
    
    return NextResponse.json({
      success: true,
      data: room,
    });
  } catch (error) {
    console.error('Error fetching room:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch room' },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/room/[id]
 * Update a room
 */
export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json(
        { success: false, error: 'Invalid room ID format' },
        { status: 400 }
      );
    }
    
    await connectToDatabase();
    
    const body: Partial<IRoom> = await request.json();
    
    // Validate dimensions if provided
    if (body.dimensions) {
      const { length, width, height } = body.dimensions;
      if ((length !== undefined && length <= 0) || 
          (width !== undefined && width <= 0) || 
          (height !== undefined && height <= 0)) {
        return NextResponse.json(
          { success: false, error: 'Invalid dimensions. All values must be positive numbers.' },
          { status: 400 }
        );
      }
    }
    
    // Validate room type if provided
    if (body.type) {
      const validTypes = ['cleanroom', 'lab', 'corridor', 'production'];
      if (!validTypes.includes(body.type)) {
        return NextResponse.json(
          { success: false, error: `Invalid room type. Must be one of: ${validTypes.join(', ')}` },
          { status: 400 }
        );
      }
    }
    
    const room = await Room.findByIdAndUpdate(
      id,
      { $set: body },
      { new: true, runValidators: true }
    ).lean();
    
    if (!room) {
      return NextResponse.json(
        { success: false, error: 'Room not found' },
        { status: 404 }
      );
    }
    
    return NextResponse.json({
      success: true,
      data: room,
      message: 'Room updated successfully',
    });
  } catch (error) {
    console.error('Error updating room:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to update room' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/room/[id]
 * Delete a room
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json(
        { success: false, error: 'Invalid room ID format' },
        { status: 400 }
      );
    }
    
    await connectToDatabase();
    
    const room = await Room.findByIdAndDelete(id);
    
    if (!room) {
      return NextResponse.json(
        { success: false, error: 'Room not found' },
        { status: 404 }
      );
    }
    
    return NextResponse.json({
      success: true,
      message: 'Room deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting room:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to delete room' },
      { status: 500 }
    );
  }
}
