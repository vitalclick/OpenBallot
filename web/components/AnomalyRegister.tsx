'use client';

import { useEffect, useMemo, useState } from 'react';

import {
  ANOMALY_LABELS,
  type AnomalyRecord,
  type AnomalyType,
} from '@/lib/types';

const SEVERITY_COLOUR: Record<number, string> = {
  1: 'bg-slate-100 text-slate-800',
  2: 'bg-amber-100 text-amber-800',
  3: 'bg-orange-100 text-orange-800',
  4: 'bg-red-100 text-red-800',
  5: 'bg-red-200 text-red-900 font-semibold',
};

export function AnomalyRegister({ electionId }: { electionId: string }) {
  const [items, setItems] = useState<AnomalyRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<AnomalyType | 'all'>('all');
  const [minSeverity, setMinSeverity] = useState(1);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const params = new URLSearchParams({
        election_id: electionId,
        min_severity: String(minSeverity),
      });
      if (filter !== 'all') params.set('type', filter);
      const r = await fetch(`/api/v1/anomalies?${params}`);
      const j = await r.json();
      setItems(j.data ?? []);
      setLoading(false);
    })();
  }, [electionId, filter, minSeverity]);

  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const it of items) out[it.anomaly_type] = (out[it.anomaly_type] || 0) + 1;
    return out;
  }, [items]);

  return (
    <div>
      <div className="flex flex-wrap gap-2 mb-4">
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value as AnomalyType | 'all')}
          className="border rounded px-2 py-1 text-sm"
        >
          <option value="all">All anomaly types</option>
          {(Object.keys(ANOMALY_LABELS) as AnomalyType[]).map((t) => (
            <option key={t} value={t}>
              {ANOMALY_LABELS[t]} ({counts[t] || 0})
            </option>
          ))}
        </select>
        <select
          value={minSeverity}
          onChange={(e) => setMinSeverity(parseInt(e.target.value, 10))}
          className="border rounded px-2 py-1 text-sm"
        >
          {[1, 2, 3, 4, 5].map((s) => (
            <option key={s} value={s}>
              Severity ≥ {s}
            </option>
          ))}
        </select>
        <span className="text-xs text-slate-500 ml-auto self-center">
          {items.length} anomal{items.length === 1 ? 'y' : 'ies'} matching
        </span>
      </div>

      {loading ? (
        <p className="text-slate-500">Loading…</p>
      ) : items.length === 0 ? (
        <p className="text-slate-500">No anomalies match the current filter.</p>
      ) : (
        <div className="space-y-3">
          {items.map((a) => (
            <article key={a.id} className="border rounded-lg bg-white p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <h3 className="font-semibold">{ANOMALY_LABELS[a.anomaly_type]}</h3>
                  <p className="text-xs text-slate-500">
                    {a.pu_name} · PU {a.pu_code} · {a.state_code} · detected{' '}
                    {new Date(a.detected_at).toLocaleString()}
                  </p>
                </div>
                <span
                  className={`px-2 py-0.5 rounded text-xs ${SEVERITY_COLOUR[a.severity]}`}
                >
                  Severity {a.severity}/5
                </span>
              </div>
              <details className="mt-2 text-xs text-slate-700">
                <summary className="cursor-pointer text-slate-500">Details</summary>
                <pre className="bg-slate-50 p-2 mt-1 rounded overflow-x-auto">
                  {JSON.stringify(a.details, null, 2)}
                </pre>
              </details>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
