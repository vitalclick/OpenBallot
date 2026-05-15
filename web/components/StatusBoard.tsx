'use client';

import { useEffect, useState } from 'react';

// Live status board. Polls the platform's own public endpoints every
// 30 seconds. Every signal is something a citizen can verify with a
// curl - we are not making claims that can't be independently checked.

interface Health {
  status: string;
  env?: string;
  timestamp?: string;
  version?: string;
}

interface Rollup {
  election_id: string;
  units_reporting: number;
  units_total: number;
  units_consensus: number;
  units_discrepancy: number;
  units_inec_confirmed: number;
  units_inec_conflict: number;
  last_updated: string;
}

interface AuditVerify {
  ok: boolean;
  events_checked: number;
  first_broken_seq: number | null;
}

const WORKER = process.env.NEXT_PUBLIC_WORKER_URL ?? '';

export function StatusBoard() {
  const [web, setWeb] = useState<Health | null>(null);
  const [worker, setWorker] = useState<Health | null>(null);
  const [chain, setChain] = useState<AuditVerify | null>(null);
  const [rollup, setRollup] = useState<Rollup | null>(null);
  const [age, setAge] = useState('—');

  async function refresh() {
    const fetchJson = async <T,>(url: string): Promise<T | null> => {
      try {
        const r = await fetch(url, { cache: 'no-store' });
        if (!r.ok) return null;
        const j = await r.json();
        return (j.data as T) ?? (j as T);
      } catch {
        return null;
      }
    };
    const [w, wk, c, ro] = await Promise.all([
      fetchJson<Health>(`/api/v1/health`),
      WORKER ? fetchJson<Health>(`${WORKER}/v1/health`) : null,
      WORKER ? fetchJson<AuditVerify>(`${WORKER}/v1/audit/verify?limit=10000`) : null,
      fetchJson<Rollup>(`/api/v1/elections/2027-presidential/results`),
    ]);
    setWeb(w);
    setWorker(wk);
    setChain(c);
    setRollup(ro);
    setAge(new Date().toLocaleTimeString());
  }

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="space-y-3">
      <div className="text-xs text-slate-500 text-right">Last refreshed: {age}</div>
      <Card
        title="Public web"
        ok={!!web && web.status === 'ok'}
        detail={web ? `env: ${web.env ?? 'unknown'}` : 'unreachable'}
      />
      <Card
        title="Worker API"
        ok={!!worker && worker.status === 'ok'}
        detail={worker ? `env: ${worker.env ?? 'unknown'}` : (WORKER ? 'unreachable' : 'not configured')}
      />
      <Card
        title="Audit chain"
        ok={!!chain && chain.ok}
        detail={
          chain
            ? chain.ok
              ? `${chain.events_checked.toLocaleString()} events verified`
              : `BROKEN at seq=${chain.first_broken_seq}`
            : 'unable to verify'
        }
      />
      <Card
        title="Active rollup"
        ok={!!rollup}
        detail={
          rollup
            ? `${rollup.units_reporting.toLocaleString()} / ${rollup.units_total.toLocaleString()} PUs reporting · ${rollup.units_consensus.toLocaleString()} consensus · ${rollup.units_inec_conflict.toLocaleString()} INEC conflicts`
            : 'no active rollup'
        }
      />
    </div>
  );
}

function Card({ title, ok, detail }: { title: string; ok: boolean; detail: string }) {
  return (
    <div className="border rounded-lg bg-white p-4 flex items-center gap-3">
      <span
        className={`inline-block w-3 h-3 rounded-full ${
          ok ? 'bg-status-consensus' : 'bg-status-conflict'
        }`}
      />
      <div>
        <div className="font-semibold">{title}</div>
        <div className="text-xs text-slate-500">{detail}</div>
      </div>
      <div className="ml-auto text-xs font-medium">
        {ok ? <span className="text-green-700">Operational</span> : <span className="text-red-700">Issue</span>}
      </div>
    </div>
  );
}
