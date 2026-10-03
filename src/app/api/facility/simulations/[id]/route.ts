import { NextRequest, NextResponse } from 'next/server';
import { getJob, getResults } from '@/backend/facility/jobs';

/**
 * GET /api/facility/simulations/[id]          job status
 * GET /api/facility/simulations/[id]?results  job status plus results once complete
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = await getJob(id);
  if (!job) return NextResponse.json({ success: false, error: 'Simulation not found' }, { status: 404 });

  const wantResults = request.nextUrl.searchParams.has('results');
  const results = wantResults && job.status === 'completed' ? await getResults(id) : null;
  return NextResponse.json({ success: true, data: { job, results } });
}
