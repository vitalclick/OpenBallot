import { NextRequest } from 'next/server';

import { jsonOk } from '@/lib/api';
import {
  mockNationalRollup,
  mockStatePartyTotals,
  mockVoterTotals,
} from '@/lib/mock-data';
import { PARTIES, seatTotalForElection } from '@/lib/parties';
import type { DashboardPartyResult, DashboardResponse } from '@/lib/types';

export const runtime = 'nodejs';

interface Params { params: { id: string } }

// Deterministic historical seat counts (for the sparkline column). Real
// data would come from the historical results layer; this keeps the
// demo dashboard self-contained.
const HISTORICAL_SEATS: Record<string, Array<{ year: number; seats: number }>> = {
  APC:  [{year:2011,seats:0},  {year:2015,seats:212},{year:2019,seats:217},{year:2023,seats:175}],
  PDP:  [{year:2011,seats:208},{year:2015,seats:140},{year:2019,seats:115},{year:2023,seats:118}],
  LP:   [{year:2011,seats:0},  {year:2015,seats:0},  {year:2019,seats:0},  {year:2023,seats:35}],
  NNPP: [{year:2011,seats:0},  {year:2015,seats:0},  {year:2019,seats:0},  {year:2023,seats:18}],
  APGA: [{year:2011,seats:6},  {year:2015,seats:5},  {year:2019,seats:9},  {year:2023,seats:5}],
  ADC:  [{year:2011,seats:0},  {year:2015,seats:0},  {year:2019,seats:3},  {year:2023,seats:2}],
  SDP:  [{year:2011,seats:0},  {year:2015,seats:0},  {year:2019,seats:1},  {year:2023,seats:2}],
  YPP:  [{year:2011,seats:0},  {year:2015,seats:0},  {year:2019,seats:0},  {year:2023,seats:1}],
  PRP:  [{year:2011,seats:0},  {year:2015,seats:0},  {year:2019,seats:0},  {year:2023,seats:0}],
  AAC:  [{year:2011,seats:0},  {year:2015,seats:0},  {year:2019,seats:0},  {year:2023,seats:0}],
};

const ELECTION_LABELS: Record<string, string> = {
  presidential: 'Presidential Election',
  reps: 'House of Representatives',
  senate: 'Senate',
  governorship: 'Gubernatorial',
  stha: 'State House of Assembly',
};

function buildMockDashboard(
  electionId: string,
  overrides: { year?: number; election?: string }
): DashboardResponse {
  const rollup = mockNationalRollup();
  const voterTotals = mockVoterTotals();
  const stateTotals = mockStatePartyTotals();

  const [parsedYear, parsedSlug] = electionId.split('-');
  const year = overrides.year ?? Number(parsedYear) ?? 2027;
  const slug = overrides.election ?? parsedSlug ?? 'presidential';
  const seatTotal = seatTotalForElection(slug);

  const partyTotals = rollup.party_totals ?? {};
  const totalValid = Object.values(partyTotals).reduce((a, b) => a + b, 0);

  const parties: DashboardPartyResult[] = PARTIES.map((p) => {
    const votes = partyTotals[p.code] ?? 0;
    const support = totalValid ? votes / totalValid : 0;
    return {
      code: p.code,
      name: p.name,
      color: p.color,
      total_votes: votes,
      support_pct: support * 100,
      seats: seatTotal === null ? null : Math.round(support * seatTotal),
      history: HISTORICAL_SEATS[p.code] ?? [],
    };
  }).sort((a, b) => b.total_votes - a.total_votes);

  const stateWinners: Record<string, string> = {};
  for (const [stateCode, totals] of Object.entries(stateTotals)) {
    let winner = '', max = -1;
    for (const [partyCode, votes] of Object.entries(totals)) {
      if (votes > max) { max = votes; winner = partyCode; }
    }
    stateWinners[stateCode] = winner;
  }

  const turnoutPct = voterTotals.registered_voters
    ? (voterTotals.accredited_voters / voterTotals.registered_voters) * 100
    : 0;

  return {
    election_id: electionId,
    election_name: ELECTION_LABELS[slug] ?? 'Presidential Election',
    election_year: year,
    seat_total: seatTotal,
    units_total: rollup.units_total,
    units_completed: rollup.units_reporting,
    total_valid_votes: totalValid,
    total_rejected_ballots: voterTotals.rejected_ballots,
    total_registered_voters: voterTotals.registered_voters,
    total_accredited_voters: voterTotals.accredited_voters,
    turnout_pct: turnoutPct,
    parties,
    state_winners: stateWinners,
    last_updated: rollup.last_updated,
  };
}

export async function GET(req: NextRequest, { params }: Params) {
  const overrides = {
    year: Number(req.nextUrl.searchParams.get('year')) || undefined,
    election: req.nextUrl.searchParams.get('election') ?? undefined,
  };
  // The dashboard view is currently mock-only; a future change will
  // back it with the same Supabase views the rest of the app uses.
  return jsonOk(buildMockDashboard(params.id, overrides));
}
