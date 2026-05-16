// Verification-status presentation helpers shared by the map page.
//
// The wire model carries seven `VerificationStatus` values. Showing
// seven equally-weighted colours overwhelms most readers, so for the
// public verification page we group them into four tiers that match
// the question a visitor actually asks: "can I trust this result?".

import { STATUS_COLOURS, type VerificationStatus } from '@/lib/types';

export type VerificationTier = 'verified' | 'provisional' | 'issue' | 'empty';

export const TIER_OF: Record<VerificationStatus, VerificationTier> = {
  consensus: 'verified',
  inec_confirmed: 'verified',
  single_source: 'provisional',
  inec_published: 'provisional',
  discrepancy: 'issue',
  inec_conflict: 'issue',
  no_data: 'empty',
};

export const TIER_ORDER: VerificationTier[] = [
  'verified',
  'provisional',
  'issue',
  'empty',
];

export const STATUS_ORDER: VerificationStatus[] = [
  'consensus',
  'inec_confirmed',
  'single_source',
  'inec_published',
  'discrepancy',
  'inec_conflict',
  'no_data',
];

export interface TierMeta {
  label: string;
  tagline: string;
  // Tailwind classes for badge backgrounds, used by the summary strip.
  tone: string;
  border: string;
  // Unicode glyph that complements the colour, for accessibility - a
  // colour-blind reader should still be able to tell tiers apart.
  glyph: string;
}

export const TIER_META: Record<VerificationTier, TierMeta> = {
  verified: {
    label: 'Verified',
    tagline: 'Independent sources agree on the figure.',
    tone: 'bg-emerald-50 text-emerald-900',
    border: 'border-emerald-200',
    glyph: '✓',
  },
  provisional: {
    label: 'Provisional',
    tagline: 'One source has reported; awaiting a second.',
    tone: 'bg-amber-50 text-amber-900',
    border: 'border-amber-200',
    glyph: '◑',
  },
  issue: {
    label: 'Needs review',
    tagline: 'Sources disagree or conflict with INEC.',
    tone: 'bg-orange-50 text-orange-900',
    border: 'border-orange-200',
    glyph: '!',
  },
  empty: {
    label: 'No data',
    tagline: 'No submission has been received yet.',
    tone: 'bg-slate-50 text-slate-700',
    border: 'border-slate-200',
    glyph: '○',
  },
};

export const STATUS_LABEL: Record<VerificationStatus, string> = {
  no_data: 'No data',
  single_source: 'Single source',
  inec_published: 'INEC published only',
  consensus: 'Multi-source consensus',
  discrepancy: 'Source discrepancy',
  inec_confirmed: 'INEC confirmed',
  inec_conflict: 'INEC conflict',
};

// One-line tooltip shown next to each status in the legend so the
// reader does not have to leave the page to learn what it means.
export const STATUS_DESCRIPTION: Record<VerificationStatus, string> = {
  no_data: 'No EC8A submitted by any source.',
  single_source: 'Only one independent party or observer has reported.',
  inec_published: 'INEC has published; awaiting independent verification.',
  consensus: 'Two or more independent sources reported the same figure.',
  discrepancy: 'Independent sources reported different figures.',
  inec_confirmed: 'Independent consensus matches the INEC figure.',
  inec_conflict: 'Independent consensus differs from the INEC figure.',
};

export function colourFor(status: VerificationStatus): string {
  return STATUS_COLOURS[status];
}

export function statusesInTier(tier: VerificationTier): VerificationStatus[] {
  return STATUS_ORDER.filter((s) => TIER_OF[s] === tier);
}
