import { NextRequest, NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/supabase';
import { isMockMode } from '@/lib/mock-data';
import { mockTile } from '@/lib/mock-tile';

export const runtime = 'nodejs';

// Public vector tile endpoint. Calls mvt_tile(z, x, y, election_id) and
// pipes the raw MVT bytes back with the correct Content-Type and a short
// edge cache window. Returns 204 on an empty tile so Mapbox GL just skips
// to the next tile without ceremony.

interface Params {
  params: { election: string; z: string; x: string; y: string };
}

const Z_MAX = 18;
const Z_MIN = 0;

// Strip the .mvt or .pbf suffix from y - Mapbox sources usually request
// /tiles/{election}/{z}/{x}/{y}.mvt but some tools omit the extension.
function parseY(raw: string): number {
  return parseInt(raw.replace(/\.(mvt|pbf)$/, ''), 10);
}

export async function GET(req: NextRequest, { params }: Params) {
  const z = parseInt(params.z, 10);
  const x = parseInt(params.x, 10);
  const y = parseY(params.y);

  if (
    !Number.isFinite(z) || !Number.isFinite(x) || !Number.isFinite(y) ||
    z < Z_MIN || z > Z_MAX || x < 0 || y < 0
  ) {
    return new NextResponse('bad tile coordinates', { status: 400 });
  }

  if (isMockMode()) {
    return mockTile({ election: params.election, z, x, y });
  }

  const { data, error } = await supabaseAdmin().rpc('mvt_tile', {
    z,
    x,
    y,
    p_election: params.election,
  });

  if (error) {
    return new NextResponse(error.message, { status: 500 });
  }

  const bytes: Buffer =
    data instanceof Uint8Array ? Buffer.from(data) : Buffer.from(data ?? '', 'binary');

  if (bytes.length === 0) {
    // Empty tile - Mapbox treats 204 as "nothing here" without retrying.
    return new NextResponse(null, { status: 204 });
  }

  return new NextResponse(bytes, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.mapbox-vector-tile',
      // Aggressive edge caching - tiles invalidate on the worker's
      // `refresh_tile_caches()` cron. During an active election we drop
      // s-maxage to 5; concluded elections like 2023 can cache for hours.
      'Cache-Control': 'public, max-age=30, s-maxage=60, stale-while-revalidate=120',
      Vary: 'Accept-Encoding',
    },
  });
}
