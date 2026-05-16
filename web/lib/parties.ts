// Registered Nigerian political parties used by the dashboard.
//
// Colours are chosen to be visually distinct on the state-level
// choropleth; they are NOT a complete or official rendering of each
// party's brand palette. Green is deliberately avoided across all
// parties so it stays reserved for the Nigerian flag / national
// identity in the rest of the UI.

export interface Party {
  code: string;
  name: string;
  color: string;
}

export const PARTIES: Party[] = [
  { code: 'APC',     name: 'All Progressives Congress',       color: '#1d4ed8' },
  { code: 'PDP',     name: 'Peoples Democratic Party',        color: '#dc2626' },
  { code: 'LP',      name: 'Labour Party',                    color: '#4338ca' },
  { code: 'NNPP',    name: 'New Nigeria Peoples Party',       color: '#ea580c' },
  { code: 'APGA',    name: 'All Progressives Grand Alliance', color: '#7c3aed' },
  { code: 'ADC',     name: 'African Democratic Congress',     color: '#0891b2' },
  { code: 'SDP',     name: 'Social Democratic Party',         color: '#facc15' },
  { code: 'YPP',     name: 'Young Progressive Party',         color: '#db2777' },
  { code: 'PRP',     name: 'Peoples Redemption Party',        color: '#9a3412' },
  { code: 'AAC',     name: 'African Action Congress',         color: '#475569' },
];

export const PARTY_BY_CODE: Record<string, Party> = Object.fromEntries(
  PARTIES.map((p) => [p.code, p])
);

// Seat counts for each legislative election type. Presidential and
// gubernatorial elections are winner-take-all so they have no seat
// allocation - SEATS_BY_ELECTION returns null in those cases.
export const SEATS_BY_ELECTION: Record<string, number | null> = {
  presidential: null,
  governorship: null,
  senate: 109,         // 3 per state x 36 + 1 for FCT
  reps: 360,           // House of Representatives
  stha: 990,           // State Houses of Assembly across all 36 states
};

export function seatTotalForElection(slug: string): number | null {
  return SEATS_BY_ELECTION[slug] ?? null;
}

// Per-state seat allocations. Senate is 3 per state (1 for FCT). Reps
// and STHA counts follow Nigeria's constituency allocations.
const SENATE_PER_STATE: Record<string, number> = Object.fromEntries(
  ['AB','AD','AK','AN','BA','BY','BE','BO','CR','DE','EB','ED','EK','EN','GO',
   'IM','JI','KD','KN','KT','KE','KO','KW','LA','NA','NI','OG','ON','OS','OY',
   'PL','RI','SO','TA','YO','ZA'].map((c) => [c, 3])
);
SENATE_PER_STATE.FC = 1;

const REPS_PER_STATE: Record<string, number> = {
  AB: 8,  AD: 8,  AK: 10, AN: 11, BA: 12, BY: 5,  BE: 11, BO: 10, CR: 8,
  DE: 10, EB: 6,  ED: 9,  EK: 6,  EN: 8,  FC: 2,  GO: 6,  IM: 10, JI: 11,
  KD: 16, KN: 24, KT: 15, KE: 8,  KO: 9,  KW: 6,  LA: 24, NA: 5,  NI: 10,
  OG: 9,  ON: 9,  OS: 9,  OY: 14, PL: 8,  RI: 13, SO: 11, TA: 6,  YO: 6,
  ZA: 7,
};

const STHA_PER_STATE: Record<string, number> = {
  AB: 24, AD: 25, AK: 26, AN: 30, BA: 30, BY: 24, BE: 30, BO: 28, CR: 25,
  DE: 29, EB: 24, ED: 24, EK: 26, EN: 24, FC: 0,  GO: 24, IM: 27, JI: 30,
  KD: 34, KN: 40, KT: 34, KE: 24, KO: 25, KW: 24, LA: 40, NA: 24, NI: 27,
  OG: 26, ON: 26, OS: 26, OY: 32, PL: 24, RI: 32, SO: 30, TA: 24, YO: 24,
  ZA: 24,
};

export function seatTotalForStateElection(
  slug: string,
  stateCode: string
): number | null {
  if (slug === 'senate') return SENATE_PER_STATE[stateCode] ?? null;
  if (slug === 'reps') return REPS_PER_STATE[stateCode] ?? null;
  if (slug === 'stha') return STHA_PER_STATE[stateCode] ?? null;
  return null;
}
