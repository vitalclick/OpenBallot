'use client';

import { type ChangeEvent, useEffect, useMemo, useState } from 'react';
import {
  Bar, BarChart, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';

import { DEFAULT_PARTY_PALETTE, UNKNOWN_PARTY_FILL } from '@/lib/party-colours';
import type {
  DeclaredWinner, PresidentialCandidate, Results2023, SeatTotal, StateRegistration,
} from '@/app/api/v1/results-2023/route';

// Brand colours for the wider 2023 party field beyond the five in the shared
// palette (which covers the front-runners). Minor parties get distinct but
// muted hues so the seat bars stay readable.
const PALETTE: Record<string, string> = {
  ...DEFAULT_PARTY_PALETTE,
  APGA: '#0e7a3b', YPP: '#e84393', SDP: '#16a085', PRP: '#d35400',
  A: '#7f8c8d', AA: '#95a5a6', AAC: '#34495e', ADP: '#2980b9', APM: '#9b59b6',
  APP: '#27ae60', BP: '#c0392b', NRM: '#e67e22', ZLP: '#1abc9c',
};
const colourFor = (code: string | null) =>
  (code && PALETTE[code]) || (code ? UNKNOWN_PARTY_FILL : '#cbd5e1');

const RACE_LABEL: Record<string, string> = {
  governorship: 'Governorship (28 states)',
  senate: 'Senate (109 seats)',
  reps: 'House of Reps (360 seats)',
  stha: 'State Assemblies (993 seats)',
};

const fmt = (n: number) => n.toLocaleString('en-NG');

export function OfficialResults2023() {
  const [data, setData] = useState<Results2023 | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let live = true;
    fetch('/api/v1/results-2023', { headers: { accept: 'application/json' } })
      .then((r) => r.json())
      .then((j) => { if (live) j?.data ? setData(j.data) : setError(true); })
      .catch(() => { if (live) setError(true); });
    return () => { live = false; };
  }, []);

  if (error) return <div className="p-10 text-red-600">Failed to load results.</div>;
  if (!data) return <div className="p-10 text-slate-500">Loading official results…</div>;

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 space-y-8">
      <DataScopeNote note={data.meta.note} />
      <Presidential
        candidates={data.presidential.candidates}
        summary={data.presidential.summary}
      />
      <SeatControl seatsByRace={data.seats_by_race} />
      <WinnersExplorer winners={data.winners} />
      <Registration rows={data.registration} />
      <p className="text-xs text-slate-500 border-t pt-3">
        Source: {data.meta.source}. Raw data:{' '}
        <a className="text-blue-700 hover:underline" href="/api/v1/results-2023">JSON</a>.
      </p>
    </div>
  );
}

function DataScopeNote({ note }: { note: string }) {
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
      <p className="font-semibold">About this dataset</p>
      <p className="mt-1 leading-relaxed">{note}</p>
      <p className="mt-1 leading-relaxed">
        This is the official INEC <strong>baseline</strong>. For crowd-sourced and IReV
        polling-unit evidence, see the live <a className="underline" href="../map">map</a> and{' '}
        <a className="underline" href="../results">results dashboard</a>.
      </p>
    </div>
  );
}

// ── Presidential ────────────────────────────────────────────────────────────
function Presidential({
  candidates, summary,
}: {
  candidates: PresidentialCandidate[];
  summary: Results2023['presidential']['summary'];
}) {
  const top = candidates.slice(0, 8);
  const chart = top.map((c) => ({
    name: c.party_code, votes: c.votes, elected: c.elected,
  }));
  return (
    <section>
      <h2 className="text-base font-semibold text-slate-800 mb-3">Presidential — national result</h2>
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-5">
        <div className="border rounded-lg bg-white p-4">
          <ResponsiveContainer width="100%" height={Math.max(220, top.length * 34)}>
            <BarChart data={chart} layout="vertical" margin={{ left: 8, right: 56 }}>
              <XAxis type="number" hide />
              <YAxis type="category" dataKey="name" width={52}
                tick={{ fontSize: 12, fill: '#475569' }} />
              <Tooltip formatter={(v: number) => fmt(v)} cursor={{ fill: '#f1f5f9' }} />
              <Bar dataKey="votes" radius={[0, 4, 4, 0]}>
                {chart.map((d) => <Cell key={d.name} fill={colourFor(d.name)} />)}
                <LabelList dataKey="votes" position="right"
                  formatter={(v: number) => fmt(v)} className="fill-slate-600 text-[11px]" />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <p className="text-xs text-slate-500 mt-1">
            Winner: <strong>{candidates.find((c) => c.elected)?.candidate_name}</strong>{' '}
            ({candidates.find((c) => c.elected)?.party_code}). All 18 candidates in the JSON.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3 content-start">
          <Stat label="Registered" value={summary.registered_voters} />
          <Stat label="Accredited" value={summary.accredited_voters} />
          <Stat label="Valid votes" value={summary.valid_votes} />
          <Stat label="Rejected" value={summary.rejected_votes} />
          <Stat label="Votes cast" value={summary.votes_cast} />
          <Stat label="Turnout" value={summary.turnout_pct} suffix="%" />
        </div>
      </div>
    </section>
  );
}

function Stat({ label, value, suffix }: { label: string; value: number; suffix?: string }) {
  return (
    <div className="border rounded-lg bg-white p-3">
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-lg font-semibold text-slate-800">
        {suffix ? value : fmt(value)}{suffix}
      </div>
    </div>
  );
}

// ── Seats by race ───────────────────────────────────────────────────────────
function SeatControl({ seatsByRace }: { seatsByRace: Record<string, SeatTotal[]> }) {
  const races = Object.keys(RACE_LABEL).filter((r) => seatsByRace[r]?.length);
  const [race, setRace] = useState(races[0] ?? 'senate');
  const seats = seatsByRace[race] ?? [];
  const total = seats.reduce((a, s) => a + s.seats, 0);
  const chart = seats.map((s) => ({ name: s.party_code, seats: s.seats }));

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h2 className="text-base font-semibold text-slate-800">Declared winners — seats by party</h2>
        <div className="flex flex-wrap gap-1">
          {races.map((r) => (
            <button key={r} onClick={() => setRace(r)}
              className={`text-xs px-2.5 py-1 rounded border ${
                r === race ? 'bg-slate-800 text-white border-slate-800'
                  : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'}`}>
              {RACE_LABEL[r].split(' (')[0]}
            </button>
          ))}
        </div>
      </div>
      <div className="border rounded-lg bg-white p-4">
        <div className="text-sm font-medium text-slate-600 mb-2">{RACE_LABEL[race]} — {total} seats</div>
        <ResponsiveContainer width="100%" height={Math.max(180, chart.length * 30)}>
          <BarChart data={chart} layout="vertical" margin={{ left: 8, right: 40 }}>
            <XAxis type="number" hide />
            <YAxis type="category" dataKey="name" width={52}
              tick={{ fontSize: 12, fill: '#475569' }} />
            <Tooltip cursor={{ fill: '#f1f5f9' }} />
            <Bar dataKey="seats" radius={[0, 4, 4, 0]}>
              {chart.map((d) => <Cell key={d.name} fill={colourFor(d.name)} />)}
              <LabelList dataKey="seats" position="right" className="fill-slate-600 text-[11px]" />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

// ── Winners explorer (browsable table, filterable by state) ────────────────
function WinnersExplorer({ winners }: { winners: DeclaredWinner[] }) {
  const states = useMemo<string[]>(
    () => [...new Set(winners.map((w) => w.state_name).filter(Boolean))].sort() as string[],
    [winners],
  );
  const [state, setState] = useState('');
  const [race, setRace] = useState('');
  const rows = winners.filter(
    (w) => (!state || w.state_name === state) && (!race || w.race === race),
  );

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h2 className="text-base font-semibold text-slate-800">Winners by constituency</h2>
        <div className="flex gap-2">
          <select value={state} onChange={(e: ChangeEvent<HTMLSelectElement>) => setState(e.target.value)}
            className="border rounded px-2 py-1 text-sm bg-white">
            <option value="">All states</option>
            {states.map((s: string) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={race} onChange={(e: ChangeEvent<HTMLSelectElement>) => setRace(e.target.value)}
            className="border rounded px-2 py-1 text-sm bg-white">
            <option value="">All races</option>
            {Object.keys(RACE_LABEL).map((r) => (
              <option key={r} value={r}>{RACE_LABEL[r].split(' (')[0]}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="border rounded-lg bg-white overflow-hidden">
        <div className="max-h-96 overflow-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-100 text-slate-600 text-xs sticky top-0">
              <tr>
                <th className="text-left font-medium px-3 py-2">Race</th>
                <th className="text-left font-medium px-3 py-2">State</th>
                <th className="text-left font-medium px-3 py-2">Constituency</th>
                <th className="text-left font-medium px-3 py-2">Party</th>
                <th className="text-left font-medium px-3 py-2">Elected candidate</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 400).map((w) => (
                <tr key={`${w.race}-${w.seq}`} className="border-t border-slate-100">
                  <td className="px-3 py-1.5 text-slate-500 capitalize">{w.race}</td>
                  <td className="px-3 py-1.5">{w.state_name ?? w.state_code}</td>
                  <td className="px-3 py-1.5 text-slate-700">{w.constituency_name || w.constituency_code}</td>
                  <td className="px-3 py-1.5">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ background: colourFor(w.party_code) }} />
                      {w.party_code ?? '—'}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-slate-600">{w.candidate_name || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="px-3 py-2 text-xs text-slate-500 border-t">
          {rows.length} constituencies{rows.length > 400 ? ' (showing first 400 — narrow by state)' : ''}.
        </div>
      </div>
    </section>
  );
}

// ── Registration ────────────────────────────────────────────────────────────
function Registration({ rows }: { rows: StateRegistration[] }) {
  const sorted = [...rows].sort((a, b) => b.total - a.total);
  const national = rows.reduce((a, r) => a + r.total, 0);
  return (
    <section>
      <h2 className="text-base font-semibold text-slate-800 mb-3">
        Registered voters by state {national ? `— ${fmt(national)} national` : ''}
      </h2>
      <div className="border rounded-lg bg-white overflow-hidden">
        <div className="max-h-80 overflow-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-100 text-slate-600 text-xs sticky top-0">
              <tr>
                <th className="text-left font-medium px-3 py-2">State</th>
                <th className="text-right font-medium px-3 py-2">Male</th>
                <th className="text-right font-medium px-3 py-2">Female</th>
                <th className="text-right font-medium px-3 py-2">Total</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.state_code} className="border-t border-slate-100">
                  <td className="px-3 py-1.5">{r.state_name ?? r.state_code}</td>
                  <td className="px-3 py-1.5 text-right text-slate-600">{fmt(r.male)}</td>
                  <td className="px-3 py-1.5 text-right text-slate-600">{fmt(r.female)}</td>
                  <td className="px-3 py-1.5 text-right font-medium text-slate-800">{fmt(r.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
