import { NextRequest } from 'next/server';

import { jsonError, jsonOk } from '@/lib/api';
import { isMockMode, mockAggregates } from '@/lib/mock-data';
import { supabaseAdmin } from '@/lib/supabase';
import type { AggregateLevel, RegionAggregate } from '@/lib/types';

export const runtime = 'nodejs';

interface Params { params: { id: string } }

// Region-level aggregates for the public map. The map renders these as
// proportional symbols (sized by `pu_count`, coloured by % consensus)
// instead of dumping 13k+ polling unit dots at country/state zoom.
//
// Query:
//   ?level=state                   -> all 37 states
//   ?level=lga&parent=LA           -> LGAs inside a state
//   ?level=ward&parent=LA-LGA-1    -> wards inside an LGA
//
// Output rows share the `RegionAggregate` shape regardless of level so
// the client renderer is uniform.
export async function GET(req: NextRequest, { params }: Params) {
  const level = (req.nextUrl.searchParams.get('level') ?? 'state') as AggregateLevel;
  const parent = req.nextUrl.searchParams.get('parent');
  if (level !== 'state' && level !== 'lga' && level !== 'ward') {
    return jsonError(400, 'bad_level', 'level must be state|lga|ward');
  }
  if ((level === 'lga' || level === 'ward') && !parent) {
    return jsonError(400, 'parent_required', `level=${level} requires ?parent=`);
  }

  if (isMockMode()) {
    return jsonOk(mockAggregates(level, parent));
  }

  const rows = await queryAggregates(params.id, level, parent);
  return jsonOk(rows);
}

async function queryAggregates(
  electionId: string,
  level: AggregateLevel,
  parent: string | null
): Promise<RegionAggregate[]> {
  const sb = supabaseAdmin();

  if (level === 'state') {
    // mv_state_centroids has pu_count + centroid; mv_state_rollup carries
    // per-status counts. Joined via state_code + election_id.
    const { data, error } = await sb.rpc('fn_state_aggregates', {
      p_election: electionId,
    });
    if (error || !data) return [];
    return data.map(rowToAggregate);
  }

  if (level === 'lga') {
    const { data, error } = await sb.rpc('fn_lga_aggregates', {
      p_election: electionId,
      p_state: parent,
    });
    if (error || !data) return [];
    return data.map(rowToAggregate);
  }

  // ward
  const { data, error } = await sb.rpc('fn_ward_aggregates', {
    p_election: electionId,
    p_lga: parent,
  });
  if (error || !data) return [];
  return data.map(rowToAggregate);
}

// The SQL functions return one row-per-region with these column names;
// see migration 0013_region_aggregates.sql.
type AggregateRow = {
  level: AggregateLevel;
  code: string;
  name: string;
  parent_code: string | null;
  state_code: string;
  pu_count: number;
  units_reporting: number;
  units_consensus: number;
  units_discrepancy: number;
  units_inec_confirmed: number;
  units_inec_conflict: number;
  units_inec_published: number;
  units_single_source: number;
  centroid_lng: number;
  centroid_lat: number;
  leader_party: string | null;
  leader_share: number | null;
};

function rowToAggregate(r: AggregateRow): RegionAggregate {
  return {
    level: r.level,
    code: r.code,
    name: r.name,
    parent_code: r.parent_code,
    state_code: r.state_code,
    pu_count: Number(r.pu_count ?? 0),
    units_reporting: Number(r.units_reporting ?? 0),
    units_consensus: Number(r.units_consensus ?? 0),
    units_discrepancy: Number(r.units_discrepancy ?? 0),
    units_inec_confirmed: Number(r.units_inec_confirmed ?? 0),
    units_inec_conflict: Number(r.units_inec_conflict ?? 0),
    units_inec_published: Number(r.units_inec_published ?? 0),
    units_single_source: Number(r.units_single_source ?? 0),
    centroid: { lng: Number(r.centroid_lng), lat: Number(r.centroid_lat) },
    leader_party: r.leader_party ?? null,
    leader_share: r.leader_share === null ? null : Number(r.leader_share),
  };
}
