// Deterministic mock data used when SUPABASE_URL is not configured.
// Lets a freshly-cloned repo demo the public map without provisioning
// any infrastructure - useful for investor demos and CI smoke tests.

import fs from 'node:fs';
import path from 'node:path';

import type {
  AggregateLevel,
  AnomalyRecord,
  DiscrepancyRecord,
  NationalRollup,
  PollingUnitDetail,
  RegionAggregate,
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

// Real Nigerian state polygons (from web/public/nigeria.geo.json,
// extracted from Natural Earth). Used to constrain mock PU coordinates
// to actually fall inside their state so the demo map looks correct.
type Ring = number[][];
type StateGeom = { rings: Ring[][]; bbox: [number, number, number, number] };

const STATE_GEOM_BY_CODE: Record<string, StateGeom> = (() => {
  const out: Record<string, StateGeom> = {};
  try {
    const file = path.join(process.cwd(), 'public', 'nigeria.geo.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      features: Array<{
        properties: { name: string; kind: string };
        geometry: { type: string; coordinates: any };
      }>;
    };
    const NAME_TO_CODE: Record<string, string> = {
      Lagos: 'LA',
      Kano: 'KN',
      Rivers: 'RI',
      'Federal Capital Territory': 'FC',
    };
    for (const f of raw.features) {
      if (f.properties.kind !== 'state') continue;
      const code = NAME_TO_CODE[f.properties.name];
      if (!code) continue;
      const polys: Ring[][] =
        f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      let lngMin = Infinity, lngMax = -Infinity, latMin = Infinity, latMax = -Infinity;
      for (const poly of polys)
        for (const ring of poly)
          for (const [lng, lat] of ring) {
            if (lng < lngMin) lngMin = lng;
            if (lng > lngMax) lngMax = lng;
            if (lat < latMin) latMin = lat;
            if (lat > latMax) latMax = lat;
          }
      out[code] = { rings: polys, bbox: [lngMin, latMin, lngMax, latMax] };
    }
  } catch {
    // file not readable at module load - fall back to bbox-only placement
  }
  return out;
})();

function pointInRing(lng: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi || 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInState(lng: number, lat: number, geom: StateGeom): boolean {
  for (const poly of geom.rings) {
    if (!poly.length) continue;
    if (!pointInRing(lng, lat, poly[0])) continue;
    let inHole = false;
    for (let h = 1; h < poly.length; h++) {
      if (pointInRing(lng, lat, poly[h])) { inHole = true; break; }
    }
    if (!inHole) return true;
  }
  return false;
}

// Deterministic pseudo-random in [0, 1) for a given seed.
function rand(seed: number): number {
  const x = Math.sin(seed * 9301 + 49297) * 233280;
  return x - Math.floor(x);
}

function pickPointInState(code: string, seed: number): { lng: number; lat: number } {
  const geom = STATE_GEOM_BY_CODE[code];
  if (!geom) {
    return { lng: 7, lat: 9 };
  }
  const [lngMin, latMin, lngMax, latMax] = geom.bbox;
  for (let i = 0; i < 40; i++) {
    const lng = lngMin + rand(seed * 2 + i) * (lngMax - lngMin);
    const lat = latMin + rand(seed * 2 + i + 1) * (latMax - latMin);
    if (pointInState(lng, lat, geom)) return { lng, lat };
  }
  // Fallback to bbox centre.
  return { lng: (lngMin + lngMax) / 2, lat: (latMin + latMax) / 2 };
}

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
  for (const state of STATES) {
    for (let i = 0; i < 60; i++) {
      seed += 1;
      const status = pickStatus(seed);
      // Per-state vote bias so the choropleth shows a varied map -
      // loosely mirrors 2023 patterns (LP in Lagos & FCT, NNPP in
      // Kano, APC in Rivers as a stand-in for a northern-leaning win).
      const bias: Record<string, Record<string, number>> = {
        LA: { APC: 0.7, PDP: 0.6, LP: 1.6, NNPP: 0.8 },
        KN: { APC: 0.9, PDP: 0.7, LP: 0.6, NNPP: 4.5 },
        RI: { APC: 1.5, PDP: 1.1, LP: 1.0, NNPP: 0.6 },
        FC: { APC: 0.9, PDP: 0.8, LP: 1.4, NNPP: 0.7 },
      };
      const b = bias[state] ?? {};
      const apc = Math.round((100 + ((seed * 7) % 200)) * (b.APC ?? 1));
      const pdp = Math.round((80 + ((seed * 11) % 180)) * (b.PDP ?? 1));
      const lp  = Math.round((150 + ((seed * 13) % 220)) * (b.LP ?? 1));
      const nnpp = Math.round((10 + ((seed * 17) % 60)) * (b.NNPP ?? 1));
      const apga = 8 + ((seed * 19) % 40);
      const adc = 5 + ((seed * 23) % 30);
      const sdp = 3 + ((seed * 29) % 20);
      const ypp = 2 + ((seed * 31) % 15);
      const prp = 2 + ((seed * 37) % 12);
      const aac = 1 + ((seed * 41) % 10);
      const total = apc + pdp + lp + nnpp + apga + adc + sdp + ypp + prp + aac;
      const coords = pickPointInState(state, seed);
      units.push({
        pu_code: `${state}-${i.toString().padStart(4, '0')}`,
        pu_name: `${STATE_NAMES[state]} PU ${i + 1}`,
        ward_code: `${state}-W${(i % 8) + 1}`,
        lga_code: `${state}-LGA-${(i % 4) + 1}`,
        state_code: state,
        coordinates: { lat: coords.lat, lng: coords.lng },
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
                candidate_votes: {
                  APC: apc, PDP: pdp, LP: lp, NNPP: nnpp,
                  APGA: apga, ADC: adc, SDP: sdp, YPP: ypp, PRP: prp, AAC: aac,
                },
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
  const totals: Record<string, number> = {};
  for (const u of units) {
    if (!u.consensus_data) continue;
    for (const [code, n] of Object.entries(u.consensus_data.candidate_votes)) {
      totals[code] = (totals[code] ?? 0) + (n as number);
    }
  }
  return {
    election_id: '2027-presidential',
    ...counts,
    party_totals: totals,
    last_updated: new Date().toISOString(),
  };
}

// Per-state party totals. Returns `{ stateCode: { partyCode: votes } }`.
export function mockStatePartyTotals(): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const u of mockPollingUnits()) {
    if (!u.consensus_data) continue;
    const s = (out[u.state_code] ??= {});
    for (const [code, n] of Object.entries(u.consensus_data.candidate_votes)) {
      s[code] = (s[code] ?? 0) + (n as number);
    }
  }
  return out;
}

// Aggregate registered/accredited voters and rejected ballots across all PUs.
export function mockVoterTotals(): {
  registered_voters: number;
  accredited_voters: number;
  rejected_ballots: number;
} {
  let registered = 0, accredited = 0, rejected = 0;
  for (const u of mockPollingUnits()) {
    if (!u.consensus_data) continue;
    registered += u.consensus_data.registered_voters;
    accredited += u.consensus_data.accredited_voters;
    rejected += u.consensus_data.rejected_ballots;
  }
  return {
    registered_voters: registered,
    accredited_voters: accredited,
    rejected_ballots: rejected,
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

// Human-readable LGA / ward labels for the mock data. The codes are
// stable (`LA-LGA-1`, `LA-W3`) but the names give the breadcrumb +
// tooltips something nicer than the raw code on a fresh clone.
const MOCK_LGA_NAMES: Record<string, string[]> = {
  LA: ['Alimosho', 'Kosofe', 'Eti-Osa', 'Ikeja'],
  KN: ['Nasarawa', 'Tarauni', 'Kumbotso', 'Fagge'],
  RI: ['Port Harcourt', 'Obio-Akpor', 'Eleme', 'Okrika'],
  FC: ['Abuja Municipal', 'Bwari', 'Gwagwalada', 'Kuje'],
};
const MOCK_WARD_NAMES: Record<string, string[]> = {
  LA: ['Ikotun', 'Egbeda', 'Mushin', 'Surulere', 'Ajegunle', 'Yaba', 'Lekki', 'Apapa'],
  KN: ['Sabon Gari', 'Fagge', 'Hotoro', 'Nasarawa', 'Brigade', 'Tarauni', 'Kumbotso', 'Gwale'],
  RI: ['Diobu', 'Mile 1', 'Rumuomasi', 'Choba', 'Eleme Town', 'Okrika Town', 'Trans Amadi', 'Borokiri'],
  FC: ['Garki', 'Wuse', 'Maitama', 'Asokoro', 'Gwarinpa', 'Kubwa', 'Lugbe', 'Karu'],
};

export function mockLgaName(code: string): string {
  // code looks like "LA-LGA-1"
  const m = /^([A-Z]{2})-LGA-(\d+)$/.exec(code);
  if (!m) return code;
  const list = MOCK_LGA_NAMES[m[1]] ?? [];
  return list[(Number(m[2]) - 1) % Math.max(list.length, 1)] ?? code;
}

export function mockWardName(code: string): string {
  // code looks like "LA-W3"
  const m = /^([A-Z]{2})-W(\d+)$/.exec(code);
  if (!m) return code;
  const list = MOCK_WARD_NAMES[m[1]] ?? [];
  return list[(Number(m[2]) - 1) % Math.max(list.length, 1)] ?? code;
}

// Centroid helper - average lng/lat across the given PUs.
function centroidOf(units: PollingUnitDetail[]): { lng: number; lat: number } {
  if (units.length === 0) return { lng: 8.7, lat: 9.1 };
  let lng = 0, lat = 0;
  for (const u of units) {
    lng += u.coordinates.lng;
    lat += u.coordinates.lat;
  }
  return { lng: lng / units.length, lat: lat / units.length };
}

function statusBuckets(units: PollingUnitDetail[]) {
  const out = {
    units_reporting: 0,
    units_consensus: 0,
    units_discrepancy: 0,
    units_inec_confirmed: 0,
    units_inec_conflict: 0,
    units_inec_published: 0,
    units_single_source: 0,
  };
  for (const u of units) {
    if (u.status !== 'no_data') out.units_reporting++;
    if (u.status === 'consensus') out.units_consensus++;
    else if (u.status === 'discrepancy') out.units_discrepancy++;
    else if (u.status === 'inec_confirmed') out.units_inec_confirmed++;
    else if (u.status === 'inec_conflict') out.units_inec_conflict++;
    else if (u.status === 'inec_published') out.units_inec_published++;
    else if (u.status === 'single_source') out.units_single_source++;
  }
  return out;
}

function leaderOf(units: PollingUnitDetail[]): { party: string | null; share: number | null } {
  const totals: Record<string, number> = {};
  let grand = 0;
  for (const u of units) {
    if (!u.consensus_data) continue;
    for (const [p, n] of Object.entries(u.consensus_data.candidate_votes)) {
      totals[p] = (totals[p] ?? 0) + (n as number);
      grand += n as number;
    }
  }
  if (grand === 0) return { party: null, share: null };
  let bestParty: string | null = null;
  let best = 0;
  for (const [p, n] of Object.entries(totals)) {
    if (n > best) { best = n; bestParty = p; }
  }
  return { party: bestParty, share: bestParty ? best / grand : null };
}

// Produce region-level aggregates from the mock PU set. `parent` filters
// LGAs to a state, and wards to an LGA - mirrors the server-side
// `/aggregates` endpoint so the demo behaves identically.
export function mockAggregates(
  level: AggregateLevel,
  parent: string | null
): RegionAggregate[] {
  const all = mockPollingUnits();
  if (level === 'state') {
    const byState = new Map<string, PollingUnitDetail[]>();
    for (const u of all) {
      const arr = byState.get(u.state_code) ?? [];
      arr.push(u);
      byState.set(u.state_code, arr);
    }
    return [...byState.entries()].map(([code, units]) => {
      const { party, share } = leaderOf(units);
      return {
        level: 'state' as const,
        code,
        name: STATE_NAMES[code] ?? code,
        parent_code: null,
        state_code: code,
        pu_count: units.length,
        centroid: centroidOf(units),
        leader_party: party,
        leader_share: share,
        ...statusBuckets(units),
      };
    });
  }
  if (level === 'lga') {
    const scoped = parent ? all.filter((u) => u.state_code === parent) : all;
    const byLga = new Map<string, PollingUnitDetail[]>();
    for (const u of scoped) {
      const arr = byLga.get(u.lga_code) ?? [];
      arr.push(u);
      byLga.set(u.lga_code, arr);
    }
    return [...byLga.entries()].map(([code, units]) => {
      const { party, share } = leaderOf(units);
      return {
        level: 'lga' as const,
        code,
        name: mockLgaName(code),
        parent_code: units[0]?.state_code ?? null,
        state_code: units[0]?.state_code ?? '',
        pu_count: units.length,
        centroid: centroidOf(units),
        leader_party: party,
        leader_share: share,
        ...statusBuckets(units),
      };
    });
  }
  // ward
  const scoped = parent ? all.filter((u) => u.lga_code === parent) : all;
  const byWard = new Map<string, PollingUnitDetail[]>();
  for (const u of scoped) {
    const arr = byWard.get(u.ward_code) ?? [];
    arr.push(u);
    byWard.set(u.ward_code, arr);
  }
  return [...byWard.entries()].map(([code, units]) => {
    const { party, share } = leaderOf(units);
    return {
      level: 'ward' as const,
      code,
      name: mockWardName(code),
      parent_code: units[0]?.lga_code ?? null,
      state_code: units[0]?.state_code ?? '',
      pu_count: units.length,
      centroid: centroidOf(units),
      leader_party: party,
      leader_share: share,
      ...statusBuckets(units),
    };
  });
}
