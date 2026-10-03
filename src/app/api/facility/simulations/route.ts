import { NextRequest, NextResponse } from 'next/server';
import { startJob } from '@/backend/facility/jobs';
import { FacilitySimulationRequest } from '@/lib/facility/types';

/** Largest grid a request may ask for, to keep a run bounded. */
const MAX_CELLS = 450_000;

/**
 * POST /api/facility/simulations
 * Start (or reuse) a whole-floor CFD run for a layout and door / flow state.
 */
export async function POST(request: NextRequest) {
  let body: FacilitySimulationRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const facility = body?.facility;
  if (!facility?.rooms?.length || !facility.extent || !Array.isArray(facility.doors)) {
    return NextResponse.json({ success: false, error: 'A facility with rooms, doors and extent is required' }, { status: 400 });
  }

  const cellSize = Math.max(0.15, Math.min(0.5, Number(body.options?.cellSize) || 0.25));
  const roomIds = Array.isArray(body.options?.roomIds) ? body.options.roomIds.filter((id) => typeof id === 'string') : undefined;
  const maxHeight = Math.max(...facility.rooms.map((r) => Number(r.height) || 0));
  // Room studies pick their own cell size within a fixed budget.
  const cells = roomIds?.length
    ? 0
    : (facility.extent.width / cellSize) * (facility.extent.depth / cellSize) * (maxHeight / cellSize);
  if (!Number.isFinite(cells) || cells > MAX_CELLS) {
    return NextResponse.json(
      { success: false, error: `That layout needs ~${Math.round(cells).toLocaleString()} cells; the limit is ${MAX_CELLS.toLocaleString()}. Use a coarser cell size.` },
      { status: 400 }
    );
  }

  const job = await startJob({
    facility,
    options: {
      doorMode: body.options?.doorMode === 'open' ? 'open' : 'closed',
      doorsOpen: body.options?.doorsOpen,
      roomFlows: body.options?.roomFlows,
      objects: Array.isArray(body.options?.objects) ? body.options.objects : undefined,
      terminalMoves: body.options?.terminalMoves,
      roomIds: roomIds?.length ? roomIds : undefined,
      doorFlowsCfm: body.options?.doorFlowsCfm,
      cellSize,
    },
  });
  return NextResponse.json({ success: true, data: job }, { status: job.status === 'completed' ? 200 : 202 });
}
