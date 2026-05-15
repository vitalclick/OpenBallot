import { NextRequest } from 'next/server';

import { jsonOk } from '@/lib/api';
import {
  isMockMode,
  mockAnomalies,
  mockDiscrepancies,
  mockPollingUnits,
} from '@/lib/mock-data';
import { supabaseAdmin } from '@/lib/supabase';
import type {
  AnomalyRecord,
  PollingUnitDetail,
  SubmissionView,
  VerificationStatus,
} from '@/lib/types';

export const runtime = 'nodejs';

// Consolidated read for the public PU detail page.
// One request returns the PU header, every submission (with extracted
// data + image url + sha256), every anomaly, and the latest audit_log
// events for the PU. Saves the page from N+1 round trips.

interface AuditEvent {
  seq: number;
  event_type: string;
  event_at: string;
  event_data: Record<string, unknown>;
  log_hash: string;
  prev_hash: string;
}

interface PUDetailResponse {
  pu: PollingUnitDetail;
  submissions: SubmissionView[];
  anomalies: AnomalyRecord[];
  audit: AuditEvent[];
  manifest: { submission_id: string; image_sha256: string }[];
}

interface Params { params: { code: string } }

export async function GET(req: NextRequest, { params }: Params) {
  const electionId = req.nextUrl.searchParams.get('election_id') ?? '2027-presidential';
  const code = params.code;

  if (isMockMode()) {
    return jsonOk(buildMockDetail(code, electionId));
  }

  const sb = supabaseAdmin();
  const [puRes, subsRes, anomRes, auditRes] = await Promise.all([
    sb.from('v_pu_live_status').select('*').eq('pu_code', code).eq('election_id', electionId).maybeSingle(),
    sb
      .from('ec8a_submissions')
      .select(
        'id, source_type, party_code, image_url, image_sha256, extracted_data, submitted_at, confidence_score'
      )
      .eq('pu_code', code)
      .eq('election_id', electionId)
      .in('review_status', ['auto_approved', 'reviewed_accepted'])
      .order('submitted_at', { ascending: false }),
    sb
      .from('v_anomaly_register')
      .select('*')
      .eq('pu_code', code)
      .eq('election_id', electionId)
      .order('severity', { ascending: false }),
    sb
      .from('audit_log')
      .select('seq, event_type, event_at, event_data, log_hash, prev_hash')
      .filter('event_data->>pu_code', 'eq', code)
      .order('seq', { ascending: false })
      .limit(50),
  ]);

  if (!puRes.data) {
    return jsonOk(buildMockDetail(code, electionId));
  }

  const pu = puRes.data as unknown as PollingUnitDetail;

  // Map Supabase row shape (id, source_type, extracted_data, confidence_score)
  // onto the SubmissionView wire shape the page expects.
  type SupaSubmissionRow = {
    id: string;
    source_type: 'party_agent' | 'observer' | 'inec_irev';
    party_code: string | null;
    image_url: string;
    image_sha256: string;
    extracted_data: unknown;
    submitted_at: string;
    confidence_score: number | null;
  };
  const submissions: SubmissionView[] = ((subsRes.data ?? []) as unknown as SupaSubmissionRow[]).map(
    (r) => ({
      submission_id: r.id,
      source: r.source_type,
      party: r.party_code,
      image_url: r.image_url,
      image_sha256: r.image_sha256,
      extracted: (r.extracted_data ?? {}) as SubmissionView['extracted'],
      submitted_at: r.submitted_at,
      confidence: r.confidence_score ?? 0,
    })
  );
  const anomalies = (anomRes.data ?? []) as unknown as AnomalyRecord[];
  const audit = (auditRes.data ?? []) as unknown as AuditEvent[];

  const manifest = submissions.map((s) => ({
    submission_id: s.submission_id,
    image_sha256: s.image_sha256,
  }));

  const payload: PUDetailResponse = {
    pu: { ...pu, submissions, submission_count: submissions.length, source_count: distinctSources(submissions) },
    submissions,
    anomalies,
    audit,
    manifest,
  };
  return jsonOk(payload);
}

function distinctSources(subs: SubmissionView[]): number {
  const keys = new Set<string>();
  for (const s of subs) {
    if (s.source === 'inec_irev') keys.add('inec_irev');
    else if (s.source === 'party_agent') keys.add(`party:${s.party ?? '?'}`);
    else keys.add(`observer:${s.submission_id}`);
  }
  return keys.size;
}

function buildMockDetail(code: string, electionId: string): PUDetailResponse {
  const all = mockPollingUnits();
  const pu = all.find((u) => u.pu_code === code) ?? all[0];

  const anomaliesForPu = mockAnomalies().filter((a) => a.pu_code === pu.pu_code);
  const submissions = mockSubmissionsFor(pu, electionId);
  const audit: AuditEvent[] = submissions.map((s, i) => ({
    seq: 1000 + i,
    event_type: i === 0 ? 'submission.extracted' : 'submission.created',
    event_at: s.submitted_at,
    event_data: { pu_code: pu.pu_code, image_sha256: s.image_sha256, party: s.party },
    log_hash: 'a'.repeat(64),
    prev_hash: 'b'.repeat(64),
  }));

  return {
    pu: { ...pu, submissions, submission_count: submissions.length, source_count: distinctSources(submissions) },
    submissions,
    anomalies: anomaliesForPu,
    audit,
    manifest: submissions.map((s) => ({
      submission_id: s.submission_id,
      image_sha256: s.image_sha256,
    })),
  };
}

function mockSubmissionsFor(pu: PollingUnitDetail, electionId: string): SubmissionView[] {
  // Build 1-3 plausible submissions per PU based on its verification status
  const baseExtracted = pu.consensus_data ?? {
    pu_code: pu.pu_code,
    registered_voters: 500,
    accredited_voters: 450,
    candidate_votes: { APC: 142, PDP: 89, LP: 203 },
    total_valid_votes: 434,
    rejected_ballots: 12,
    total_votes_cast: 446,
    presiding_officer_signed: true,
    agent_signatures_detected: 3,
    official_stamp_present: true,
  };
  const sources: SubmissionView[] = [];
  const hasInec = pu.status !== 'no_data' && pu.status !== 'single_source';
  if (hasInec) {
    sources.push({
      submission_id: `s-${pu.pu_code}-inec`,
      source: 'inec_irev',
      party: null,
      image_url: 'https://placehold.co/640x880?text=INEC+IReV',
      image_sha256: 'a'.repeat(64),
      extracted: baseExtracted,
      submitted_at: new Date(Date.now() - 1000 * 60 * 90).toISOString(),
      confidence: 1.0,
    });
  }
  if (pu.status === 'consensus' || pu.status === 'inec_confirmed' || pu.status === 'discrepancy' || pu.status === 'inec_conflict') {
    sources.push({
      submission_id: `s-${pu.pu_code}-apc`,
      source: 'party_agent',
      party: 'APC',
      image_url: 'https://placehold.co/640x880?text=APC+agent',
      image_sha256: 'b'.repeat(64),
      extracted: baseExtracted,
      submitted_at: new Date(Date.now() - 1000 * 60 * 65).toISOString(),
      confidence: 0.94,
    });
    sources.push({
      submission_id: `s-${pu.pu_code}-lp`,
      source: 'party_agent',
      party: 'LP',
      image_url: 'https://placehold.co/640x880?text=LP+agent',
      image_sha256: 'c'.repeat(64),
      extracted:
        pu.status === 'discrepancy' || pu.status === 'inec_conflict'
          ? {
              ...baseExtracted,
              candidate_votes: {
                ...baseExtracted.candidate_votes,
                APC: (baseExtracted.candidate_votes.APC ?? 0) + 47,
              },
            }
          : baseExtracted,
      submitted_at: new Date(Date.now() - 1000 * 60 * 32).toISOString(),
      confidence: 0.92,
    });
  }
  return sources;
}
