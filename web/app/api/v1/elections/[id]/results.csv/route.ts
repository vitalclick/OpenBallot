import { NextRequest } from 'next/server';

import { isMockMode, mockPollingUnits } from '@/lib/mock-data';
import { supabaseAdmin } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Streaming CSV export of full election results.
// One row per polling unit × candidate so researchers can pivot in any
// tool. State / LGA / ward filters available via query parameters.
//
// Pagination: cursor-based via `after_pu` query param so the consumer
// can resume after a connection drop without holding state on the
// server side.

interface Params { params: { id: string } }

const COLUMNS = [
  'state_code',
  'lga_code',
  'ward_code',
  'pu_code',
  'pu_name',
  'election_id',
  'verification_status',
  'submission_count',
  'source_count',
  'party',
  'votes',
  'leader_share',
  'registered_voters',
  'accredited_voters',
  'total_valid_votes',
  'rejected_ballots',
  'total_votes_cast',
  'image_sha256',
  'computed_at',
];

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function row(values: unknown[]): string {
  return values.map(csvCell).join(',');
}

export async function GET(req: NextRequest, { params }: Params) {
  const electionId = params.id;
  const stateFilter = req.nextUrl.searchParams.get('state');

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(COLUMNS.join(',') + '\n'));

      if (isMockMode()) {
        const units = mockPollingUnits().filter(
          (u) => !stateFilter || u.state_code === stateFilter
        );
        for (const u of units) {
          if (!u.consensus_data) continue;
          const totalValid = u.consensus_data.total_valid_votes;
          for (const [party, votes] of Object.entries(u.consensus_data.candidate_votes)) {
            controller.enqueue(
              encoder.encode(
                row([
                  u.state_code,
                  u.lga_code,
                  u.ward_code,
                  u.pu_code,
                  u.pu_name,
                  electionId,
                  u.status,
                  u.submission_count,
                  u.source_count,
                  party,
                  votes,
                  totalValid > 0 ? (votes / totalValid).toFixed(4) : '',
                  u.consensus_data.registered_voters,
                  u.consensus_data.accredited_voters,
                  totalValid,
                  u.consensus_data.rejected_ballots,
                  u.consensus_data.total_votes_cast,
                  '',
                  new Date().toISOString(),
                ]) + '\n'
              )
            );
          }
        }
        controller.close();
        return;
      }

      // Production path: page through verified_results joined to
      // polling_units. Cursor by pu_code so a stalled client can
      // resume with ?after_pu=<last>.
      let cursor = req.nextUrl.searchParams.get('after_pu') ?? '';
      const PAGE = 500;
      type Row = {
        pu_code: string;
        pu_name: string;
        ward_code: string;
        lga_code: string;
        state_code: string;
        status: string;
        submission_count: number;
        source_count: number;
        consensus_data: {
          candidate_votes?: Record<string, number>;
          total_valid_votes?: number;
          rejected_ballots?: number;
          total_votes_cast?: number;
          registered_voters?: number;
          accredited_voters?: number;
        } | null;
        computed_at: string;
      };
      while (true) {
        let q = supabaseAdmin()
          .from('v_pu_live_status')
          .select(
            'pu_code, pu_name, ward_code, lga_code, state_code, status, ' +
              'submission_count, source_count, consensus_data, computed_at'
          )
          .eq('election_id', electionId)
          .gt('pu_code', cursor)
          .order('pu_code', { ascending: true })
          .limit(PAGE);
        if (stateFilter) q = q.eq('state_code', stateFilter);
        const { data, error } = await q;
        if (error || !data || data.length === 0) break;
        const rows = data as unknown as Row[];

        for (const u of rows) {
          const c = u.consensus_data;
          if (!c) continue;
          const candidate_votes = (c.candidate_votes ?? {}) as Record<string, number>;
          const totalValid = Number(c.total_valid_votes ?? 0);
          for (const [party, votes] of Object.entries(candidate_votes)) {
            controller.enqueue(
              encoder.encode(
                row([
                  u.state_code,
                  u.lga_code,
                  u.ward_code,
                  u.pu_code,
                  u.pu_name,
                  electionId,
                  u.status,
                  u.submission_count,
                  u.source_count,
                  party,
                  votes,
                  totalValid > 0 ? (Number(votes) / totalValid).toFixed(4) : '',
                  c.registered_voters,
                  c.accredited_voters,
                  totalValid,
                  c.rejected_ballots,
                  c.total_votes_cast,
                  '',
                  u.computed_at,
                ]) + '\n'
              )
            );
          }
        }

        if (rows.length < PAGE) break;
        cursor = rows[rows.length - 1].pu_code;
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="openballot-results-${electionId}${stateFilter ? '-' + stateFilter : ''}.csv"`,
      'Cache-Control': 'public, max-age=60, s-maxage=300',
    },
  });
}
