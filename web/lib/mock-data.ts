// Deterministic mock data used when SUPABASE_URL is not configured.
// Lets a freshly-cloned repo demo the public map without provisioning
// any infrastructure - useful for investor demos and CI smoke tests.

import type {
  AnomalyRecord,
  DiscrepancyRecord,
  NationalRollup,
  PollingUnitDetail,
  SubmissionView,
  VerificationStatus,
} from './types';

const STATES = ['LA', 'KN', 'RI', 'FC'];
const STATE_NAMES: Record<string, string> = {
  LA: 'Lagos',
  KN: 'Kano',
  RI: 'Rivers',
  FC: 'FCT',
};

const STATUSES: VerificationStatus[] = [
  'no_data',
  'single_source',
  'consensus',
  'discrepancy',
  'inec_confirmed',
  'inec_conflict',
];

function pickStatus(seed: number): VerificationStatus {
  // weight toward consensus so the demo map looks healthy
  // Weighted toward the 2023 demo dataset: mostly `inec_published` (the
  // historical IReV-only state), with a sprinkling of multi-source states
  // illustrating what the platform looks like during a live 2027 election.
  const weighted: VerificationStatus[] = [
    'inec_published',
    'inec_published',
    'inec_published',
    'inec_published',
    'inec_published',
    'no_data',
    'single_source',
    'consensus',
    'consensus',
    'inec_confirmed',
    'discrepancy',
    'inec_conflict',
  ];
  return weighted[seed % weighted.length];
}

export function mockPollingUnits(): PollingUnitDetail[] {
  const units: PollingUnitDetail[] = [];
  let seed = 0;
  const seedPoints: [string, number, number][] = [
    ['LA', 3.3515, 6.4969],
    ['KN', 8.5167, 12.0022],
    ['RI', 7.0134, 4.8156],
    ['FC', 7.4868, 9.0563],
  ];
  for (const [state, baseLng, baseLat] of seedPoints) {
    for (let i = 0; i < 60; i++) {
      seed += 1;
      const status = pickStatus(seed);
      const apc = 100 + ((seed * 7) % 200);
      const pdp = 80 + ((seed * 11) % 180);
      const lp = 150 + ((seed * 13) % 220);
      const total = apc + pdp + lp;
      units.push({
        pu_code: `${state}-${i.toString().padStart(4, '0')}`,
        pu_name: `${STATE_NAMES[state]} PU ${i + 1}`,
        ward_code: `${state}-W${(i % 8) + 1}`,
        lga_code: `${state}-LGA-${(i % 4) + 1}`,
        state_code: state,
        coordinates: {
          lat: baseLat + ((seed * 0.0017) % 0.5) - 0.25,
          lng: baseLng + ((seed * 0.0023) % 0.5) - 0.25,
        },
        status,
        submission_count: status === 'no_data' ? 0 : 1 + (seed % 3),
        source_count: status === 'no_data' ? 0 : 1 + (seed % 3),
        consensus_data:
          status === 'no_data'
            ? null
            : {
                pu_code: `${state}-${i.toString().padStart(4, '0')}`,
                registered_voters: 412,
                accredited_voters: 287,
                candidate_votes: { APC: apc, PDP: pdp, LP: lp },
                total_valid_votes: total,
                rejected_ballots: 12,
                total_votes_cast: total + 12,
                presiding_officer_signed: true,
                agent_signatures_detected: 3,
                official_stamp_present: true,
              },
        submissions: [],
      });
    }
  }
  return units;
}

export function mockNationalRollup(): NationalRollup {
  const units = mockPollingUnits();
  const counts = {
    units_total: units.length,
    units_reporting: units.filter((u) => u.status !== 'no_data').length,
    units_consensus: units.filter((u) => u.status === 'consensus').length,
    units_discrepancy: units.filter((u) => u.status === 'discrepancy').length,
    units_inec_confirmed: units.filter((u) => u.status === 'inec_confirmed').length,
    units_inec_conflict: units.filter((u) => u.status === 'inec_conflict').length,
  };
  let apc = 0, pdp = 0, lp = 0;
  for (const u of units) {
    if (u.consensus_data) {
      apc += u.consensus_data.candidate_votes.APC ?? 0;
      pdp += u.consensus_data.candidate_votes.PDP ?? 0;
      lp += u.consensus_data.candidate_votes.LP ?? 0;
    }
  }
  return {
    election_id: '2027-presidential',
    ...counts,
    party_totals: { APC: apc, PDP: pdp, LP: lp },
    last_updated: new Date().toISOString(),
  };
}

export function mockDiscrepancies(): DiscrepancyRecord[] {
  const units = mockPollingUnits().filter(
    (u) => u.status === 'discrepancy' || u.status === 'inec_conflict'
  );
  return units.slice(0, 12).map((u, idx) => {
    const apc = 142 + idx;
    const apcAlt = u.status === 'inec_conflict' ? apc : apc + 47;
    const subs: SubmissionView[] = [
      {
        submission_id: `s-${u.pu_code}-a`,
        source: 'party_agent',
        party: 'APC',
        image_url: 'https://placehold.co/640x880?text=EC8A+APC',
        image_sha256: 'a'.repeat(64),
        extracted: {
          ...(u.consensus_data ?? ({} as any)),
          pu_code: u.pu_code,
          candidate_votes: { APC: apc, PDP: 89, LP: 203 },
        },
        submitted_at: new Date(Date.now() - 1000 * 60 * 32).toISOString(),
        confidence: 0.97,
      },
      {
        submission_id: `s-${u.pu_code}-b`,
        source: u.status === 'inec_conflict' ? 'inec_irev' : 'party_agent',
        party: u.status === 'inec_conflict' ? null : 'LP',
        image_url: 'https://placehold.co/640x880?text=EC8A+B',
        image_sha256: 'b'.repeat(64),
        extracted: {
          ...(u.consensus_data ?? ({} as any)),
          pu_code: u.pu_code,
          candidate_votes: { APC: apcAlt, PDP: 89, LP: 203 },
        },
        submitted_at: new Date(Date.now() - 1000 * 60 * 8).toISOString(),
        confidence: 0.93,
      },
    ];
    return {
      id: `d-${idx}`,
      election_id: '2027-presidential',
      pu_code: u.pu_code,
      pu_name: u.pu_name,
      state_code: u.state_code,
      detected_at: new Date(Date.now() - 1000 * 60 * 32).toISOString(),
      differing_fields: u.status === 'inec_conflict'
        ? ['candidate_votes.APC', 'total_valid_votes']
        : ['candidate_votes.APC'],
      severity: u.status === 'inec_conflict' ? 5 : 3,
      escalation_status: u.status === 'inec_conflict' ? 'notified' : 'open',
      submissions: subs,
    };
  });
}

export function mockAnomalies(): AnomalyRecord[] {
  // Drawn from the same mock units as discrepancies + a few extras so the
  // anomaly register has variety on a fresh clone.
  const units = mockPollingUnits().slice(0, 18);
  const types: AnomalyRecord['anomaly_type'][] = [
    'votes_exceed_registered',
    'turnout_exceeds_accreditation',
    'leader_extreme_share',
    'turnout_outlier_ward',
    'leader_share_outlier_ward',
    'turnout_shift_vs_2023',
    'leader_party_shift_vs_2023',
  ];
  return units.map((u, i) => {
    const type = types[i % types.length];
    const sev: 1 | 2 | 3 | 4 | 5 =
      type === 'votes_exceed_registered' || type === 'turnout_exceeds_accreditation'
        ? 5
        : type === 'leader_extreme_share' || type === 'turnout_shift_vs_2023'
        ? 4
        : 3;
    let details: Record<string, unknown> = {};
    if (type === 'votes_exceed_registered') {
      details = { registered: 412, cast: 580, excess: 168 };
    } else if (type === 'leader_extreme_share') {
      details = { leader: 'APC', share: 0.985, leader_votes: 428, total_valid: 434 };
    } else if (type === 'turnout_outlier_ward') {
      details = { z_score: 6.2, pu_turnout: 0.98, ward_mean: 0.61, ward_stddev: 0.06, ward_n: 22 };
    } else if (type === 'turnout_shift_vs_2023') {
      details = { current_turnout: 0.89, baseline_turnout: 0.32, shift_pp: 57 };
    } else if (type === 'leader_party_shift_vs_2023') {
      details = {
        current_leader: 'APC',
        current_share: 0.91,
        baseline_leader: 'LP',
        baseline_share: 0.28,
        share_shift_pp: 63,
      };
    }
    return {
      id: `anom-${i}`,
      election_id: '2027-presidential',
      pu_code: u.pu_code,
      pu_name: u.pu_name,
      ward_code: u.ward_code,
      lga_code: u.lga_code,
      state_code: u.state_code,
      anomaly_type: type,
      severity: sev,
      details,
      detected_at: new Date(Date.now() - 1000 * 60 * (10 + i * 4)).toISOString(),
      resolved_at: null,
      submission_id: null,
    };
  });
}

export function isMockMode(): boolean {
  return !process.env.NEXT_PUBLIC_SUPABASE_URL;
}
