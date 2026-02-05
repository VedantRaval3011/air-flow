import { NextRequest, NextResponse } from 'next/server';
import connectToDatabase from '@/db/connection';
import Room from '@/db/models/Room';
import { CreateRoomRequest, IRoom } from '@/types';

/**
 * GET /api/room
 * Retrieve all rooms
 */
export async function GET() {
  try {
    await connectToDatabase();
    
    const rooms = await Room.find().sort({ createdAt: -1 }).lean();
    
    return NextResponse.json({
      success: true,
      data: rooms,
      count: rooms.length,
    });
  } catch (error) {
    console.error('Error fetching rooms:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch rooms' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/room
 * Create a new room
 */
export async function POST(request: NextRequest) {
  try {
    await connectToDatabase();
    
    const body: CreateRoomRequest = await request.json();
    
    // Validate required fields
    if (!body.name || !body.type || !body.dimensions) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields: name, type, dimensions' },
        { status: 400 }
      );
    }
    
    // Validate dimensions
    const { length, width, height } = body.dimensions;
    if (!length || !width || !height || length <= 0 || width <= 0 || height <= 0) {
      return NextResponse.json(
        { success: false, error: 'Invalid dimensions. All values must be positive numbers.' },
        { status: 400 }
      );
    }
    
    // Validate room type
    const validTypes = ['cleanroom', 'lab', 'corridor', 'production'];
    if (!validTypes.includes(body.type)) {
      return NextResponse.json(
        { success: false, error: `Invalid room type. Must be one of: ${validTypes.join(', ')}` },
        { status: 400 }
      );
    }
    
    // Create room
    const room = await Room.create({
      name: body.name.trim(),
      type: body.type,
      dimensions: {
        length: body.dimensions.length,
        width: body.dimensions.width,
        height: body.dimensions.height,
      },
    });
    
    return NextResponse.json({
      success: true,
      data: room,
      message: 'Room created successfully',
    }, { status: 201 });
    
  } catch (error) {
    console.error('Error creating room:', error);
    
    // Handle mongoose validation errors
    if (error instanceof Error && error.name === 'ValidationError') {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 400 }
      );
    }
    
    return NextResponse.json(
      { success: false, error: 'Failed to create room' },
      { status: 500 }
    );
  }
}
