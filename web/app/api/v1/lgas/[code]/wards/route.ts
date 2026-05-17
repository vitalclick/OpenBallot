import { NextRequest } from 'next/server';

import { jsonError, jsonOk } from '@/lib/api';
import { isMockMode } from '@/lib/mock-data';
import { supabaseAdmin } from '@/lib/supabase';

export const runtime = 'nodejs';

interface Params { params: { code: string } }

// Ward polygons inside a given LGA. Backs the LGA-focused view of the
// public results map, where each ward is drawn as a filled polygon
// (replacing the older proportional-symbol circles). Polygons come
// from ward_boundaries (GRID3 Nigeria Operational Wards layer); wards
// whose GRID3 reconciliation hasn't been resolved are still returned
// with geometry=null so the client can fall back to a centroid symbol.
//
// Output: a vanilla GeoJSON FeatureCollection so the client can pass
// it straight to its rendering pipeline.
export async function GET(_req: NextRequest, { params }: Params) {
  const lgaCode = decodeURIComponent(params.code || '').trim();
  if (!lgaCode) {
    return jsonError(400, 'missing_lga', 'lga code is required');
  }

  if (isMockMode()) {
    return jsonOk(emptyFeatureCollection());
  }

  const sb = supabaseAdmin();
  const { data, error } = await sb.rpc('fn_lga_ward_polygons', {
    p_lga: lgaCode,
  });
  if (error) {
    return jsonError(500, 'db_error', error.message);
  }

  const features = (data ?? []).map((row: WardPolygonRow) => ({
    type: 'Feature' as const,
    properties: {
      ward_code: row.code,
      name: row.name,
      lga_code: row.lga_code,
      state_code: row.state_code,
      match_confidence: row.match_confidence,
      source: row.boundary_source,
    },
    geometry: row.geometry,
  }));

  return jsonOk({ type: 'FeatureCollection' as const, features });
}

interface WardPolygonRow {
  code: string;
  name: string;
  lga_code: string;
  state_code: string;
  match_confidence: number | null;
  boundary_source: string | null;
  geometry: GeoJSON.MultiPolygon | null;
}

function emptyFeatureCollection() {
  return { type: 'FeatureCollection' as const, features: [] };
}
