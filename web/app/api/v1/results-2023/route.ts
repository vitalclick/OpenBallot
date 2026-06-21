import { NextRequest } from 'next/server';

import { jsonOk } from '@/lib/api';
import { isMockMode } from '@/lib/mock-data';
import { supabaseAdmin } from '@/lib/supabase';

export const runtime = 'nodejs';

// Official 2023 General Election results, extracted from the INEC report PDF
// (Annexures 2-6 + Table 8.9) and loaded by scripts/load_2023_results.py into
// the migration-0015 tables. This is a published, concluded, fully-public
// reference dataset — distinct from the per-polling-unit verification surface.
//
// The report only carries: presidential totals at NATIONAL level, the WINNING
// PARTY of each constituency for the other four races (no vote tallies), and
// per-state registration counts. The endpoint therefore returns the
// presidential tally, seat-by-party aggregates per race, the full winners
// list, and registration — but nothing per polling unit.

export interface PresidentialCandidate {
  party_code: string;
  candidate_name: string;
  votes: number;
  elected: boolean;
  display_order: number;
}
export interface PresidentialSummary {
  registered_voters: number;
  collected_pvcs: number;
  accredited_voters: number;
  votes_cast: number;
  valid_votes: number;
  rejected_votes: number;
  turnout_pct: number;
}
export interface DeclaredWinner {
  race: string;
  seq: number;
  constituency_code: string;
  constituency_name: string | null;
  state_code: string;
  state_name: string | null;
  party_code: string | null;
  candidate_name: string | null;
}
export interface SeatTotal { party_code: string; seats: number }
export interface StateRegistration {
  state_code: string;
  state_name: string | null;
  male: number;
  female: number;
  total: number;
}
export interface Results2023 {
  presidential: { candidates: PresidentialCandidate[]; summary: PresidentialSummary };
  seats_by_race: Record<string, SeatTotal[]>;
  winners: DeclaredWinner[];
  registration: StateRegistration[];
  meta: { source: string; note: string };
}

const RACES = ['governorship', 'senate', 'reps', 'stha'] as const;

function aggregateSeats(winners: DeclaredWinner[]): Record<string, SeatTotal[]> {
  const out: Record<string, SeatTotal[]> = {};
  for (const race of RACES) {
    const counts = new Map<string, number>();
    for (const w of winners) {
      if (w.race !== race) continue;
      const key = w.party_code ?? '—';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    out[race] = [...counts.entries()]
      .map(([party_code, seats]) => ({ party_code, seats }))
      .sort((a, b) => b.seats - a.seats);
  }
  return out;
}

const META = {
  source:
    'INEC, Report of the 2023 General Election (Feb 2024) — Annexures 2-6, Table 8.9',
  note:
    'Presidential totals are national only; legislative/governorship rows are declared winning party (no vote tallies); nothing per polling unit. As declared in the report (pre-tribunal).',
};

export async function GET(_req: NextRequest) {
  if (isMockMode()) {
    return jsonOk(MOCK_RESULTS_2023);
  }

  const sb = supabaseAdmin();
  const eid = '2023-presidential';

  const [pres, summ, winRows, reg, states] = await Promise.all([
    sb.from('presidential_2023_results')
      .select('party_code, candidate_name, votes, elected, display_order')
      .eq('election_id', eid).order('display_order'),
    sb.from('presidential_2023_summary').select('*').eq('election_id', eid).single(),
    sb.from('declared_winners_2023')
      .select('race, seq, constituency_code, constituency_name, state_code, party_code, candidate_name')
      .order('race').order('seq'),
    sb.from('state_registration_2023').select('state_code, male, female, total'),
    sb.from('states').select('code, name'),
  ]);

  if (pres.error || summ.error || winRows.error || reg.error || states.error) {
    return jsonOk(MOCK_RESULTS_2023); // fail open with the published figures
  }

  const stateName = new Map(
    (states.data ?? []).map((s: { code: string; name: string }) => [s.code, s.name]),
  );
  const winners: DeclaredWinner[] = (winRows.data ?? []).map((w: Record<string, unknown>) => ({
    race: w.race as string,
    seq: w.seq as number,
    constituency_code: w.constituency_code as string,
    constituency_name: (w.constituency_name as string | null) ?? null,
    state_code: w.state_code as string,
    state_name: stateName.get(w.state_code as string) ?? null,
    party_code: (w.party_code as string | null) ?? null,
    candidate_name: (w.candidate_name as string | null) ?? null,
  }));

  const payload: Results2023 = {
    presidential: {
      candidates: (pres.data ?? []) as PresidentialCandidate[],
      summary: summ.data as PresidentialSummary,
    },
    seats_by_race: aggregateSeats(winners),
    winners,
    registration: (reg.data ?? []).map((r: Record<string, unknown>) => ({
      state_code: r.state_code as string,
      state_name: stateName.get(r.state_code as string) ?? null,
      male: r.male as number,
      female: r.female as number,
      total: r.total as number,
    })),
    meta: META,
  };
  return jsonOk(payload);
}

// ── Mock fallback (no Supabase configured). Real published figures so the
// dedicated page renders correctly on a fresh clone / in CI. Seat aggregates
// mirror the as-declared composition; the winners list is abbreviated. ──────
const MOCK_RESULTS_2023: Results2023 = {
  presidential: {
    candidates: [
      { party_code: 'APC', candidate_name: 'Tinubu Bola Ahmed', votes: 8794726, elected: true, display_order: 1 },
      { party_code: 'PDP', candidate_name: 'Abubakar Atiku', votes: 6984520, elected: false, display_order: 2 },
      { party_code: 'LP', candidate_name: 'Obi Peter Gregory', votes: 6101533, elected: false, display_order: 3 },
      { party_code: 'NNPP', candidate_name: 'Musa Mohammed Rabiu Kwankwaso', votes: 1496687, elected: false, display_order: 4 },
      { party_code: 'ADC', candidate_name: 'Kachikwu Dumebi', votes: 81919, elected: false, display_order: 5 },
      { party_code: 'SDP', candidate_name: 'Adebayo Adewole Ebenezer', votes: 80267, elected: false, display_order: 6 },
    ],
    summary: {
      registered_voters: 93469008, collected_pvcs: 87209007, accredited_voters: 25286616,
      votes_cast: 24965218, valid_votes: 24025940, rejected_votes: 939278, turnout_pct: 27.05,
    },
  },
  seats_by_race: {
    governorship: [{ party_code: 'APC', seats: 17 }, { party_code: 'PDP', seats: 9 }, { party_code: 'LP', seats: 1 }, { party_code: 'NNPP', seats: 1 }],
    senate: [{ party_code: 'APC', seats: 59 }, { party_code: 'PDP', seats: 36 }, { party_code: 'LP', seats: 8 }, { party_code: 'NNPP', seats: 2 }, { party_code: 'SDP', seats: 2 }, { party_code: 'APGA', seats: 1 }, { party_code: 'YPP', seats: 1 }],
    reps: [{ party_code: 'APC', seats: 177 }, { party_code: 'PDP', seats: 116 }, { party_code: 'LP', seats: 37 }, { party_code: 'NNPP', seats: 19 }, { party_code: 'APGA', seats: 5 }, { party_code: 'YPP', seats: 2 }, { party_code: 'ADC', seats: 2 }, { party_code: 'SDP', seats: 2 }],
    stha: [{ party_code: 'APC', seats: 535 }, { party_code: 'PDP', seats: 355 }, { party_code: 'LP', seats: 37 }, { party_code: 'NNPP', seats: 29 }, { party_code: 'APGA', seats: 20 }, { party_code: 'YPP', seats: 8 }, { party_code: 'SDP', seats: 6 }],
  },
  winners: [
    { race: 'governorship', seq: 1, constituency_code: 'GOV/LA', constituency_name: 'Lagos Governor', state_code: 'LA', state_name: 'Lagos', party_code: 'APC', candidate_name: null },
    { race: 'governorship', seq: 2, constituency_code: 'GOV/KN', constituency_name: 'Kano Governor', state_code: 'KN', state_name: 'Kano', party_code: 'NNPP', candidate_name: null },
    { race: 'governorship', seq: 3, constituency_code: 'GOV/RI', constituency_name: 'Rivers Governor', state_code: 'RI', state_name: 'Rivers', party_code: 'PDP', candidate_name: null },
  ],
  registration: [
    { state_code: 'LA', state_name: 'Lagos', male: 3803396, female: 3256799, total: 7060195 },
    { state_code: 'KN', state_name: 'Kano', male: 3292291, female: 2629079, total: 5921370 },
    { state_code: 'RI', state_name: 'Rivers', male: 1885293, female: 1651897, total: 3537190 },
    { state_code: 'FC', state_name: 'FCT', male: 856962, female: 713345, total: 1570307 },
  ],
  meta: META,
};
