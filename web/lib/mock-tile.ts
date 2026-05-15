// Minimal in-process MVT response for mock mode.
//
// We do not implement an MVT encoder in the scaffold's mock path - the
// renderer falls back to its non-MVT data source automatically. We just
// return 204 so the Mapbox layer behaves as if no features are present
// in the tile, and the SVG fallback (or the legacy circle source) takes
// over.

import { NextResponse } from 'next/server';

export function mockTile(_args: {
  election: string;
  z: number;
  x: number;
  y: number;
}) {
  return new NextResponse(null, {
    status: 204,
    headers: { 'Cache-Control': 'public, max-age=60' },
  });
}
