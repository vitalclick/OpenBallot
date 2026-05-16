'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { ChoroplethMap } from '@/components/ChoroplethMap';
import type { DashboardResponse, DashboardPartyResult } from '@/lib/types';

// Recreates the public results dashboard layout used by election
// commissions (loosely modelled after results.elections.org.za).
//
// Filter state lives in the URL (?year=&election=&ballot=) so the
// page is bookmarkable and the selectors auto-navigate on change.

const ELECTION_OPTIONS: Array<{ slug: string; label: string }> = [
  { slug: 'presidential', label: 'Presidential Election' },
  { slug: 'senate',       label: 'Senate' },
  { slug: 'reps',         label: 'House of Representatives' },
  { slug: 'governorship', label: 'Gubernatorial' },
  { slug: 'stha',         label: 'State House of Assembly' },
];

const YEAR_OPTIONS = [2027, 2023, 2019, 2015, 2011];

interface Props { defaultElectionId: string }

export function ResultsDashboard({ defaultElectionId }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const defaults = useMemo(() => {
    const [year, slug] = defaultElectionId.split('-');
    return {
      year: Number(year) || 2027,
      election: slug || 'presidential',
    };
  }, [defaultElectionId]);

  const year = Number(searchParams.get('year')) || defaults.year;
  const election = searchParams.get('election') || defaults.election;

  const electionId = `${year}-${election}`;
  const setFilter = useCallback(
    (key: 'year' | 'election', value: string) => {
      const next = new URLSearchParams(searchParams.toString());
      next.set(key, value);
      router.replace(`?${next.toString()}`, { scroll: false });
    },
    [router, searchParams]
  );

  const [data, setData] = useState<DashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      const qs = new URLSearchParams({ year: String(year), election });
      const r = await fetch(`/api/v1/elections/${electionId}/dashboard?${qs}`, {
        cache: 'no-store',
      });
      const j = await r.json();
      if (!cancelled && j.data) setData(j.data as DashboardResponse);
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [electionId, year, election]);

  if (loading && !data) {
    return <div className="p-10 text-slate-500">Loading dashboard…</div>;
  }
  if (!data) {
    return <div className="p-10 text-red-600">Failed to load dashboard.</div>;
  }

  const completedPct = data.units_total ? (data.units_completed / data.units_total) * 100 : 0;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-6 max-w-7xl mx-auto px-4 py-6">
      <FiltersPanel
        year={year}
        election={election}
        onChange={setFilter}
      />
      <div className={`space-y-6 ${loading ? 'opacity-60 pointer-events-none' : ''}`}>
        <Title data={data} />
        <CompletionRibbon
          pct={completedPct}
          completed={data.units_completed}
          total={data.units_total}
        />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <ValidSpoiltCard
            valid={data.total_valid_votes}
            rejected={data.total_rejected_ballots}
          />
          <TurnoutCard pct={data.turnout_pct} />
        </div>
        <QuickLinks electionId={data.election_id} />
        <LeadingParties parties={data.parties.slice(0, 3)} totalValid={data.total_valid_votes} />
        <ChoroplethSection winners={data.state_winners} parties={data.parties} />
        <PartyResultsTable parties={data.parties} seatTotal={data.seat_total} />
        <p className="text-xs text-slate-500 pt-2">
          Last updated {new Date(data.last_updated).toLocaleString()} ·{' '}
          <a href={`/api/v1/elections/${data.election_id}/dashboard`} className="hover:underline">JSON</a>
        </p>
      </div>
    </div>
  );
}

function FiltersPanel({
  year,
  election,
  onChange,
}: {
  year: number;
  election: string;
  onChange: (key: 'year' | 'election', value: string) => void;
}) {
  return (
    <aside className="space-y-3 lg:sticky lg:top-20 lg:self-start">
      <FilterCard step="1" colour="bg-sky-600" label="Select Election Year">
        <select
          className="w-full border rounded px-2 py-1 text-sm bg-white"
          value={year}
          onChange={(e) => onChange('year', e.target.value)}
        >
          {YEAR_OPTIONS.map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>
      </FilterCard>
      <FilterCard step="2" colour="bg-orange-500" label="Select Election">
        <select
          className="w-full border rounded px-2 py-1 text-sm bg-white"
          value={election}
          onChange={(e) => onChange('election', e.target.value)}
        >
          {ELECTION_OPTIONS.map((o) => (
            <option key={o.slug} value={o.slug}>{o.label}</option>
          ))}
        </select>
      </FilterCard>
    </aside>
  );
}

function FilterCard({
  step,
  colour,
  label,
  children,
}: {
  step: string;
  colour: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`${colour} rounded-md p-3 text-white shadow-sm`}>
      <div className="flex items-center gap-2 text-xs font-medium">
        <span className="inline-flex w-5 h-5 items-center justify-center rounded-full bg-white text-slate-900 font-bold text-[11px]">
          {step}
        </span>
        <span>{label}</span>
      </div>
      <div className="mt-2 text-slate-900">{children}</div>
    </div>
  );
}

function Title({ data }: { data: DashboardResponse }) {
  return (
    <h1 className="text-center text-2xl md:text-3xl font-semibold text-slate-800">
      {data.election_name} – {data.election_year}
    </h1>
  );
}

function CompletionRibbon({
  pct,
  completed,
  total,
}: {
  pct: number;
  completed: number;
  total: number;
}) {
  return (
    <div className="flex flex-col items-center">
      <div className="relative w-48 h-32 flex items-center justify-center">
        <svg viewBox="0 0 200 130" className="absolute inset-0 w-full h-full">
          <path
            d="M 20 5 L 180 5 L 180 95 L 100 125 L 20 95 Z"
            fill="#1e3a8a"
            stroke="#1e40af"
            strokeWidth="2"
          />
        </svg>
        <div className="relative text-center text-white">
          <div className="text-2xl font-bold">{pct.toFixed(0)}%</div>
          <div className="text-xs uppercase tracking-wider opacity-90">Complete</div>
        </div>
      </div>
      <p className="text-sm text-slate-600 mt-2">
        {completed.toLocaleString()} of {total.toLocaleString()} polling units completed
      </p>
    </div>
  );
}

function ValidSpoiltCard({ valid, rejected }: { valid: number; rejected: number }) {
  const total = valid + rejected;
  const validPct = total ? (valid / total) * 100 : 0;
  const spoiltPct = total ? (rejected / total) * 100 : 0;

  // Simple SVG donut (avoid pulling in a chart lib for two slices).
  const r = 60, c = 2 * Math.PI * r;
  const validLen = (validPct / 100) * c;

  return (
    <div className="border rounded-lg bg-white p-5">
      <div className="text-center text-sm font-medium text-slate-600 mb-3">Valid / Spoilt Votes</div>
      <div className="flex items-center justify-center gap-6">
        <svg viewBox="0 0 160 160" className="w-32 h-32">
          <circle cx="80" cy="80" r={r} fill="none" stroke="#f59e0b" strokeWidth="22" />
          <circle
            cx="80"
            cy="80"
            r={r}
            fill="none"
            stroke="#0ea5e9"
            strokeWidth="22"
            strokeDasharray={`${validLen} ${c - validLen}`}
            strokeDashoffset={c / 4}
            transform="rotate(-90 80 80)"
          />
        </svg>
        <div className="text-xs space-y-2">
          <Legend dot="#0ea5e9" label={`Valid Votes ${validPct.toFixed(2)}%`} />
          <Legend dot="#f59e0b" label={`Spoilt Votes ${spoiltPct.toFixed(2)}%`} />
          <div className="pt-2 text-slate-500">
            {valid.toLocaleString()} valid<br />
            {rejected.toLocaleString()} rejected
          </div>
        </div>
      </div>
    </div>
  );
}

function Legend({ dot, label }: { dot: string; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="inline-block w-3 h-3 rounded-full" style={{ background: dot }} />
      <span>{label}</span>
    </div>
  );
}

function TurnoutCard({ pct }: { pct: number }) {
  return (
    <div className="border rounded-lg bg-white p-5">
      <div className="text-center text-sm font-medium text-slate-600 mb-3">Voter Turnout</div>
      <div className="flex flex-col items-center justify-center h-32">
        <div className="border-4 border-slate-200 rounded-lg px-6 py-4">
          <div className="text-3xl font-semibold text-sky-600 text-center">{pct.toFixed(2)}%</div>
        </div>
      </div>
    </div>
  );
}

function QuickLinks({ electionId }: { electionId: string }) {
  return (
    <div className="grid grid-cols-3 gap-3">
      <QuickCard
        icon="🌍"
        label="Out of Country"
        href={`/en/map`}
      />
      <QuickCard
        icon="📍"
        label="Results Finder"
        href={`/en/map`}
      />
      <QuickCard
        icon="📥"
        label="Downloadable Results"
        href={`/api/v1/elections/${electionId}/results.csv`}
      />
    </div>
  );
}

function QuickCard({ icon, label, href }: { icon: string; label: string; href: string }) {
  return (
    <a
      href={href}
      className="flex flex-col items-center justify-center border rounded-lg bg-white p-4 hover:bg-slate-50 text-center"
    >
      <span className="text-2xl mb-2">{icon}</span>
      <span className="text-sm">{label}</span>
    </a>
  );
}

function LeadingParties({
  parties,
  totalValid,
}: {
  parties: DashboardPartyResult[];
  totalValid: number;
}) {
  return (
    <div className="border rounded-lg bg-white p-4">
      <div className="text-center text-sm font-medium text-slate-600 mb-3">
        Leading party by polling unit
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {parties.map((p) => (
          <div key={p.code} className="flex items-center gap-3">
            <span
              className="inline-flex w-10 h-10 rounded-full items-center justify-center text-white font-bold text-sm"
              style={{ background: p.color }}
              aria-hidden
            >
              {p.code.slice(0, 3)}
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold">{p.code}</div>
              <div className="text-xs text-slate-500 truncate">{p.name}</div>
            </div>
            <div className="text-right">
              <div className="text-xs text-slate-500">Support</div>
              <div className="font-semibold">{p.support_pct.toFixed(2)}%</div>
              <div className="text-xs text-slate-500">
                {p.total_votes.toLocaleString()} votes
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ChoroplethSection({
  winners,
  parties,
}: {
  winners: Record<string, string>;
  parties: DashboardPartyResult[];
}) {
  const partyByCode = useMemo(
    () => Object.fromEntries(parties.map((p) => [p.code, p])),
    [parties]
  );
  return (
    <div className="border rounded-lg bg-white p-4">
      <div className="text-sm font-medium text-slate-600 mb-3 text-center">
        Leading party by state
      </div>
      <div className="grid grid-cols-1 md:grid-cols-[1fr_180px] gap-4 items-start">
        <ChoroplethMap winners={winners} partyByCode={partyByCode} />
        <div className="text-xs space-y-1">
          {parties.map((p) => (
            <div key={p.code} className="flex items-center gap-2">
              <span
                className="inline-block w-3 h-3 rounded-sm"
                style={{ background: p.color }}
              />
              <span className="font-medium">{p.code}</span>
              <span className="text-slate-500 truncate">{p.name}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function PartyResultsTable({
  parties,
  seatTotal,
}: {
  parties: DashboardPartyResult[];
  seatTotal: number | null;
}) {
  // Presidential and gubernatorial races are winner-take-all under
  // Nigerian law - no seat allocation, so the column is hidden.
  const showSeats = seatTotal !== null;
  return (
    <div className="border rounded-lg bg-white overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 border-b">
          <tr>
            <th className="text-left p-3">Party</th>
            <th className="text-right p-3">Votes</th>
            <th className="text-right p-3">Support</th>
            {showSeats && (
              <th className="text-right p-3">Seats ({seatTotal})</th>
            )}
            <th className="text-right p-3 hidden md:table-cell">History</th>
          </tr>
        </thead>
        <tbody>
          {parties.map((p) => (
            <tr key={p.code} className="border-b last:border-0">
              <td className="p-3">
                <div className="flex items-center gap-3">
                  <span
                    className="inline-block w-1 h-8 rounded-sm"
                    style={{ background: p.color }}
                  />
                  <div>
                    <div className="font-semibold">{p.code}</div>
                    <div className="text-xs text-slate-500">{p.name}</div>
                  </div>
                </div>
              </td>
              <td className="p-3 text-right tabular-nums">{p.total_votes.toLocaleString()}</td>
              <td className="p-3 text-right tabular-nums">{p.support_pct.toFixed(2)}%</td>
              {showSeats && (
                <td className="p-3 text-right tabular-nums">{p.seats ?? '—'}</td>
              )}
              <td className="p-3 hidden md:table-cell">
                <HistoryBars history={p.history} color={p.color} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HistoryBars({
  history,
  color,
}: {
  history: Array<{ year: number; seats: number }>;
  color: string;
}) {
  if (!history.length) return <span className="text-xs text-slate-400">—</span>;
  const max = Math.max(...history.map((h) => h.seats), 1);
  return (
    <div className="flex items-end gap-1 justify-end h-10">
      {history.map((h) => (
        <div key={h.year} className="flex flex-col items-center" title={`${h.year}: ${h.seats} seats`}>
          <div
            className="w-3 rounded-t"
            style={{
              height: `${(h.seats / max) * 32 + 2}px`,
              background: color,
              opacity: h.seats === 0 ? 0.25 : 1,
            }}
          />
          <span className="text-[10px] text-slate-500 mt-0.5">{`'${h.year.toString().slice(2)}`}</span>
        </div>
      ))}
    </div>
  );
}
