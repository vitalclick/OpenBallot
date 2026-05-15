'use client';

import { useEffect, useState } from 'react';

import {
  ANOMALY_LABELS,
  type AnomalyRecord,
  type PollingUnitDetail as PUDetail,
  STATUS_COLOURS,
  type SubmissionView,
} from '@/lib/types';

interface AuditEvent {
  seq: number;
  event_type: string;
  event_at: string;
  event_data: Record<string, unknown>;
  log_hash: string;
  prev_hash: string;
}

interface DetailPayload {
  pu: PUDetail;
  submissions: SubmissionView[];
  anomalies: AnomalyRecord[];
  audit: AuditEvent[];
  manifest: { submission_id: string; image_sha256: string }[];
}

const STATUS_LABEL: Record<string, string> = {
  no_data: 'No data',
  single_source: 'Single source',
  inec_published: 'INEC published',
  consensus: 'Consensus',
  discrepancy: 'Discrepancy',
  inec_confirmed: 'INEC confirmed',
  inec_conflict: 'INEC conflict',
};

export function PollingUnitDetailView({
  puCode,
  electionId,
}: {
  puCode: string;
  electionId: string;
}) {
  const [detail, setDetail] = useState<DetailPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [shareCopied, setShareCopied] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const r = await fetch(
        `/api/v1/polling-units/${encodeURIComponent(puCode)}/detail?election_id=${electionId}`
      );
      const j = await r.json();
      setDetail(j.data);
      setLoading(false);
    })();
  }, [puCode, electionId]);

  if (loading) {
    return <p className="text-slate-500">Loading polling unit detail…</p>;
  }
  if (!detail) {
    return <p className="text-slate-500">Polling unit not found.</p>;
  }

  const { pu, submissions, anomalies, audit, manifest } = detail;
  const statusColour = STATUS_COLOURS[pu.status];
  const statusLabel = STATUS_LABEL[pu.status] ?? pu.status;

  return (
    <div className="space-y-8">
      <header>
        <div className="text-xs uppercase tracking-wider text-slate-500">{pu.state_code}</div>
        <h1 className="text-3xl font-bold mt-1">{pu.pu_name}</h1>
        <p className="text-sm text-slate-600 mt-1">
          PU code <span className="font-mono">{pu.pu_code}</span> · ward {pu.ward_code} · LGA {pu.lga_code}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <span
            className="inline-flex items-center gap-2 px-3 py-1 rounded text-sm font-medium"
            style={{ background: statusColour + '22', color: '#0f172a' }}
          >
            <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: statusColour }} />
            {statusLabel}
          </span>
          <span className="text-xs text-slate-500">
            {pu.submission_count} submission{pu.submission_count === 1 ? '' : 's'} from{' '}
            {pu.source_count} independent source{pu.source_count === 1 ? '' : 's'}
          </span>
          <button
            onClick={async () => {
              if (typeof navigator !== 'undefined' && navigator.clipboard) {
                await navigator.clipboard.writeText(window.location.href);
                setShareCopied(true);
                setTimeout(() => setShareCopied(false), 2000);
              }
            }}
            className="ml-auto text-xs text-blue-700 hover:underline"
          >
            {shareCopied ? 'Link copied' : 'Copy share link'}
          </button>
        </div>
      </header>

      {pu.consensus_data && (
        <section>
          <h2 className="font-semibold mb-2">Consensus result</h2>
          <table className="w-full text-sm">
            <tbody>
              {Object.entries(pu.consensus_data.candidate_votes).map(([party, votes]) => (
                <tr key={party} className="border-b last:border-0">
                  <td className="py-1.5">{party}</td>
                  <td className="py-1.5 text-right tabular-nums">{votes.toLocaleString()}</td>
                </tr>
              ))}
              <tr className="font-semibold border-t">
                <td className="py-1.5">Total valid</td>
                <td className="py-1.5 text-right tabular-nums">
                  {pu.consensus_data.total_valid_votes.toLocaleString()}
                </td>
              </tr>
              <tr>
                <td className="py-1.5 text-slate-500">Rejected</td>
                <td className="py-1.5 text-right tabular-nums text-slate-500">
                  {pu.consensus_data.rejected_ballots.toLocaleString()}
                </td>
              </tr>
              <tr>
                <td className="py-1.5 text-slate-500">Registered voters</td>
                <td className="py-1.5 text-right tabular-nums text-slate-500">
                  {pu.consensus_data.registered_voters.toLocaleString()}
                </td>
              </tr>
              <tr>
                <td className="py-1.5 text-slate-500">Accredited</td>
                <td className="py-1.5 text-right tabular-nums text-slate-500">
                  {pu.consensus_data.accredited_voters.toLocaleString()}
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      )}

      <section>
        <h2 className="font-semibold mb-2">Submissions ({submissions.length})</h2>
        {submissions.length === 0 ? (
          <p className="text-sm text-slate-500">No submissions on file.</p>
        ) : (
          <div className="grid md:grid-cols-2 gap-4">
            {submissions.map((s) => (
              <article key={s.submission_id} className="border rounded p-3 bg-slate-50">
                <div className="flex justify-between text-xs">
                  <span className="font-semibold">
                    {s.source === 'inec_irev'
                      ? 'INEC IReV'
                      : `${s.source.replace('_', ' ')}${s.party ? ` · ${s.party}` : ''}`}
                  </span>
                  <span className="text-slate-500">
                    confidence {(s.confidence * 100).toFixed(0)}%
                  </span>
                </div>
                <a href={s.image_url} target="_blank" rel="noopener noreferrer" className="block mt-2">
                  <img
                    src={s.image_url}
                    alt="EC8A"
                    className="w-full rounded border"
                    loading="lazy"
                  />
                </a>
                <table className="w-full text-xs mt-2">
                  <tbody>
                    {Object.entries(s.extracted.candidate_votes).map(([p, v]) => (
                      <tr key={p}>
                        <td className="py-0.5">{p}</td>
                        <td className="py-0.5 text-right tabular-nums">{v.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="mt-2 text-xs text-slate-500 font-mono break-all">
                  sha256:{s.image_sha256}
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  submitted {new Date(s.submitted_at).toLocaleString()}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {anomalies.length > 0 && (
        <section>
          <h2 className="font-semibold mb-2">Anomalies ({anomalies.length})</h2>
          <ul className="space-y-2">
            {anomalies.map((a) => (
              <li key={a.id} className="border rounded p-3 bg-white">
                <div className="flex justify-between items-baseline">
                  <span className="font-medium text-sm">
                    {ANOMALY_LABELS[a.anomaly_type]}
                  </span>
                  <span className="text-xs px-2 py-0.5 rounded bg-red-100 text-red-800">
                    Severity {a.severity}/5
                  </span>
                </div>
                <details className="text-xs text-slate-700 mt-1">
                  <summary className="cursor-pointer text-slate-500">Details</summary>
                  <pre className="bg-slate-50 p-2 mt-1 rounded overflow-x-auto">
                    {JSON.stringify(a.details, null, 2)}
                  </pre>
                </details>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2 className="font-semibold mb-2">Audit chain</h2>
        <p className="text-xs text-slate-500 mb-2">
          The last {audit.length} chained audit events touching this polling unit. Each
          row&apos;s log_hash links to the previous row; any rewrite breaks the chain.
        </p>
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-slate-500 border-b">
              <th className="py-1.5">seq</th>
              <th>event</th>
              <th>at</th>
              <th>hash</th>
            </tr>
          </thead>
          <tbody>
            {audit.map((e) => (
              <tr key={e.seq} className="border-b">
                <td className="py-1 font-mono">{e.seq}</td>
                <td>{e.event_type}</td>
                <td className="text-slate-500">{new Date(e.event_at).toLocaleString()}</td>
                <td className="font-mono text-slate-500">{e.log_hash.slice(0, 16)}…</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2 className="font-semibold mb-2">SHA-256 manifest</h2>
        <p className="text-xs text-slate-500 mb-2">
          Every EC8A image displayed above is bound to its SHA-256 here. Download the full
          election manifest at{' '}
          <a className="text-blue-700 hover:underline" href={`/api/v1/audit/hashes?election_id=${pu.consensus_data ? '2027-presidential' : '2027-presidential'}`}>
            /api/v1/audit/hashes
          </a>{' '}
          to verify offline.
        </p>
        <pre className="text-xs bg-slate-50 p-3 rounded overflow-x-auto">
{manifest.map((m) => `${m.submission_id}\t${m.image_sha256}`).join('\n')}
        </pre>
      </section>
    </div>
  );
}
