// Wire types shared with the worker. Kept in sync by hand for now; a future
// improvement is to codegen these from the Pydantic models.

export type ElectionType =
  | 'presidential'
  | 'senate'
  | 'reps'
  | 'governorship'
  | 'stha'
  | 'fct_area'
  | 'lga';

export type VerificationStatus =
  | 'no_data'
  | 'single_source'
  | 'inec_published'
  | 'consensus'
  | 'discrepancy'
  | 'inec_confirmed'
  | 'inec_conflict';

export type SubmissionSource = 'party_agent' | 'observer' | 'inec_irev';

export interface ExtractedEC8A {
  pu_code: string;
  registered_voters: number;
  accredited_voters: number;
  candidate_votes: Record<string, number>;
  total_valid_votes: number;
  rejected_ballots: number;
  total_votes_cast: number;
  presiding_officer_signed: boolean;
  agent_signatures_detected: number;
  official_stamp_present: boolean;
}

export interface SubmissionView {
  submission_id: string;
  source: SubmissionSource;
  party?: string | null;
  image_url: string;
  image_sha256: string;
  extracted: ExtractedEC8A;
  submitted_at: string;
  confidence: number;
}

export interface PollingUnitDetail {
  pu_code: string;
  pu_name: string;
  ward_code: string;
  lga_code: string;
  state_code: string;
  coordinates: { lat: number; lng: number };
  status: VerificationStatus;
  submission_count: number;
  source_count: number;
  consensus_data: ExtractedEC8A | null;
  submissions: SubmissionView[];
}

export interface NationalRollup {
  election_id: string;
  units_reporting: number;
  units_total: number;
  units_consensus: number;
  units_discrepancy: number;
  units_inec_confirmed: number;
  units_inec_conflict: number;
  party_totals?: Record<string, number>;
  last_updated: string;
}

export interface DiscrepancyRecord {
  id: string;
  election_id: string;
  pu_code: string;
  pu_name: string;
  state_code: string;
  detected_at: string;
  differing_fields: string[];
  severity: number;
  escalation_status: 'open' | 'notified' | 'acknowledged' | 'resolved';
  submissions: SubmissionView[];
}

export type AnomalyType =
  | 'votes_exceed_registered'
  | 'turnout_exceeds_accreditation'
  | 'rejected_exceeds_cast'
  | 'leader_extreme_share'
  | 'zero_registered_voters'
  | 'cast_zero_but_votes_recorded'
  | 'turnout_outlier_ward'
  | 'turnout_outlier_lga'
  | 'leader_share_outlier_ward'
  | 'turnout_shift_vs_2023'
  | 'leader_party_shift_vs_2023';

export interface AnomalyRecord {
  id: string;
  election_id: string;
  pu_code: string;
  pu_name: string;
  ward_code: string;
  lga_code: string;
  state_code: string;
  anomaly_type: AnomalyType;
  severity: 1 | 2 | 3 | 4 | 5;
  details: Record<string, unknown>;
  detected_at: string;
  resolved_at: string | null;
  submission_id: string | null;
}

export const ANOMALY_LABELS: Record<AnomalyType, string> = {
  votes_exceed_registered: 'Votes cast exceeds registered voters',
  turnout_exceeds_accreditation: 'Turnout exceeds accreditation',
  rejected_exceeds_cast: 'Rejected ballots exceed total cast',
  leader_extreme_share: 'Leader received an extreme share (>=97%)',
  zero_registered_voters: 'Registered voters reported as zero',
  cast_zero_but_votes_recorded: 'Votes recorded with zero total cast',
  turnout_outlier_ward: 'Turnout is a statistical outlier in the ward',
  turnout_outlier_lga: 'Turnout is a statistical outlier in the LGA',
  leader_share_outlier_ward: 'Leader share is a statistical outlier in the ward',
  turnout_shift_vs_2023: 'Turnout shifted dramatically vs. 2023 baseline',
  leader_party_shift_vs_2023: 'Winning party flipped with extreme share swing vs. 2023',
};

export interface DashboardPartyResult {
  code: string;
  name: string;
  color: string;
  total_votes: number;
  support_pct: number;
  // null for presidential/gubernatorial (winner-take-all, no seat allocation).
  seats: number | null;
  history: Array<{ year: number; seats: number }>;
}

export interface DashboardResponse {
  election_id: string;
  election_name: string;
  election_year: number;
  // Total seats up for grabs (e.g. 360 for House of Reps). null for
  // presidential/gubernatorial races where the table hides the column.
  seat_total: number | null;
  units_total: number;
  units_completed: number;
  total_valid_votes: number;
  total_rejected_ballots: number;
  total_registered_voters: number;
  total_accredited_voters: number;
  turnout_pct: number;
  parties: DashboardPartyResult[];
  state_winners: Record<string, string>;
  // Raw per-state party totals so the dashboard can recompute the
  // results table when the user drills into a state on the choropleth.
  state_party_totals: Record<string, Record<string, number>>;
  last_updated: string;
}

// Per-region aggregate used by the map at country/state/LGA zoom levels.
// `level` tells the renderer which administrative unit a row represents;
// `code` is the INEC code (state.code, lga.code, or ward.code) and `name`
// is the human-readable label shown in the breadcrumb + tooltips.
//
// Counts are restricted to the requested election. `centroid` is the
// representative point used to place the proportional symbol on the map.
export type AggregateLevel = 'state' | 'lga' | 'ward';

export interface RegionAggregate {
  level: AggregateLevel;
  code: string;
  name: string;
  parent_code: string | null;        // state_code for lga; lga_code for ward
  state_code: string;
  pu_count: number;
  units_reporting: number;
  units_consensus: number;
  units_discrepancy: number;
  units_inec_confirmed: number;
  units_inec_conflict: number;
  units_inec_published: number;
  units_single_source: number;
  centroid: { lng: number; lat: number };
  leader_party: string | null;       // party with the most consensus/IReV votes
  leader_share: number | null;       // 0..1, fraction of valid votes
}

export const STATUS_COLOURS: Record<VerificationStatus, string> = {
  no_data: '#e5e7eb',
  single_source: '#f6c453',
  inec_published: '#64748b',   // slate - "INEC has published; awaiting independent verification"
  consensus: '#22c55e',
  discrepancy: '#f97316',
  inec_confirmed: '#2563eb',
  inec_conflict: '#dc2626',
};
