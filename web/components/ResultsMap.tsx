'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import { MapboxRenderer } from '@/components/MapboxRenderer';
import { STATUS_COLOURS, type PollingUnitDetail, type VerificationStatus } from '@/lib/types';

// The public results map.
//
// In production this is a Mapbox GL JS choropleth with polling-unit dot
// layers. The runtime requires NEXT_PUBLIC_MAPBOX_TOKEN. To keep the
// scaffold runnable without that token (so investors can see the page on a
// fresh clone), we render a deterministic SVG fallback when no token is
// configured. The data binding and interaction layer are identical to the
// real map, so swapping the renderer is a one-file change.

const STATUS_LABEL: Record<VerificationStatus, string> = {
  no_data: 'No data',
  single_source: 'Single source',
  inec_published: 'INEC published',
  consensus: 'Consensus',
  discrepancy: 'Discrepancy',
  inec_confirmed: 'INEC confirmed',
  inec_conflict: 'INEC conflict',
};

interface Props { electionId: string }

export function ResultsMap({ electionId }: Props) {
  const [units, setUnits] = useState<PollingUnitDetail[]>([]);
  const [filter, setFilter] = useState<VerificationStatus | 'all'>('all');
  const [selected, setSelected] = useState<PollingUnitDetail | null>(null);
  const mapboxToken =
    typeof window === 'undefined' ? undefined : process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await fetch(`/api/v1/elections/${electionId}/units`);
      const j = await r.json();
      if (!cancelled) setUnits(j.data ?? []);
    })();
    return () => { cancelled = true; };
  }, [electionId]);

  const filtered = useMemo(
    () => (filter === 'all' ? units : units.filter((u) => u.status === filter)),
    [units, filter]
  );

  // Realtime: subscribe to verification_status changes via Server-Sent Events.
  useEffect(() => {
    const es = new EventSource(`/api/v1/elections/${electionId}/stream`);
    es.addEventListener('verified_result', (ev: MessageEvent) => {
      try {
        const update = JSON.parse(ev.data) as { pu_code: string; status: VerificationStatus };
        setUnits((prev) =>
          prev.map((u) => (u.pu_code === update.pu_code ? { ...u, status: update.status } : u))
        );
      } catch {/* ignore malformed events */}
    });
    es.onerror = () => es.close();
    return () => es.close();
  }, [electionId]);

  return (
    <div className="grid grid-cols-1 md:grid-cols-[1fr_360px] h-full">
      <div ref={containerRef} className="relative bg-slate-100">
        {mapboxToken ? (
          <MapboxRenderer
            electionId={electionId}
            token={mapboxToken}
            onSelect={setSelected}
          />
        ) : (
          <SvgFallback units={filtered} onSelect={setSelected} />
        )}
        <Legend />
        <FilterBar value={filter} onChange={setFilter} />
      </div>
      <aside className="border-l bg-white overflow-y-auto">
        <PUDetailPane unit={selected} />
      </aside>
    </div>
  );
}

function FilterBar({
  value,
  onChange,
}: {
  value: VerificationStatus | 'all';
  onChange: (v: VerificationStatus | 'all') => void;
}) {
  const opts: Array<VerificationStatus | 'all'> = [
    'all',
    'no_data',
    'single_source',
    'inec_published',
    'consensus',
    'discrepancy',
    'inec_confirmed',
    'inec_conflict',
  ];
  return (
    <div className="absolute top-3 left-3 bg-white rounded-md shadow px-2 py-1 flex flex-wrap gap-1 max-w-[90%]">
      {opts.map((s) => (
        <button
          key={s}
          onClick={() => onChange(s)}
          className={`px-2 py-1 text-xs rounded ${
            value === s ? 'bg-slate-900 text-white' : 'hover:bg-slate-100'
          }`}
        >
          {s === 'all' ? 'All' : STATUS_LABEL[s as VerificationStatus]}
        </button>
      ))}
    </div>
  );
}

function Legend() {
  return (
    <div className="absolute bottom-3 left-3 bg-white rounded-md shadow p-3 text-xs">
      <div className="font-semibold mb-1">Verification status</div>
      {(Object.keys(STATUS_COLOURS) as VerificationStatus[]).map((s) => (
        <div key={s} className="flex items-center gap-2 py-0.5">
          <span className="status-dot" style={{ background: STATUS_COLOURS[s] }} />
          <span>{STATUS_LABEL[s]}</span>
        </div>
      ))}
    </div>
  );
}

function SvgFallback({
  units,
  onSelect,
}: {
  units: PollingUnitDetail[];
  onSelect: (u: PollingUnitDetail) => void;
}) {
  // Map Nigeria's bounding box onto the viewbox.
  const W = 1000, H = 700;
  const lngMin = 2.5, lngMax = 14.7, latMin = 4, latMax = 14;
  const toX = (lng: number) => ((lng - lngMin) / (lngMax - lngMin)) * W;
  const toY = (lat: number) => H - ((lat - latMin) / (latMax - latMin)) * H;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-full">
      <rect x={0} y={0} width={W} height={H} fill="#f8fafc" />
      {/* very rough Nigeria outline so the dots have geographical context */}
      <path
        d="M 130 320 L 200 230 L 300 200 L 420 180 L 540 170 L 660 200 L 760 240 L 820 320 L 800 420 L 720 500 L 600 540 L 480 540 L 360 520 L 240 460 L 160 400 Z"
        fill="#ffffff"
        stroke="#cbd5e1"
        strokeWidth={2}
      />
      {units.map((u) => (
        <circle
          key={u.pu_code}
          cx={toX(u.coordinates.lng)}
          cy={toY(u.coordinates.lat)}
          r={5}
          fill={STATUS_COLOURS[u.status]}
          stroke="#0f172a"
          strokeOpacity={0.2}
          strokeWidth={0.5}
          style={{ cursor: 'pointer' }}
          onClick={() => onSelect(u)}
        >
          <title>
            {u.pu_name} — {STATUS_LABEL[u.status]}
          </title>
        </circle>
      ))}
    </svg>
  );
}

function PUDetailPane({ unit }: { unit: PollingUnitDetail | null }) {
  if (!unit) {
    return (
      <div className="p-6 text-sm text-slate-500">
        Click a polling unit on the map to see its EC8A submissions, extracted figures, and
        verification status.
      </div>
    );
  }
  return (
    <div className="p-5">
      <div className="text-xs uppercase text-slate-500 tracking-wider">{unit.state_code}</div>
      <h2 className="font-semibold text-lg leading-tight">{unit.pu_name}</h2>
      <div className="mt-1 text-xs text-slate-500">PU {unit.pu_code}</div>

      <div
        className="mt-3 inline-flex items-center gap-2 px-2 py-1 rounded text-xs font-medium"
        style={{ background: STATUS_COLOURS[unit.status] + '33', color: '#0f172a' }}
      >
        <span className="status-dot" style={{ background: STATUS_COLOURS[unit.status] }} />
        {STATUS_LABEL[unit.status]}
      </div>

      <div className="mt-4 text-sm space-y-2">
        <div className="flex justify-between">
          <span className="text-slate-500">Submissions</span>
          <span>{unit.submission_count}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">Independent sources</span>
          <span>{unit.source_count}</span>
        </div>
      </div>

      {unit.consensus_data && (
        <div className="mt-4">
          <div className="font-medium text-sm">Consensus result</div>
          <table className="w-full mt-2 text-sm">
            <tbody>
              {Object.entries(unit.consensus_data.candidate_votes).map(([p, v]) => (
                <tr key={p} className="border-b last:border-0">
                  <td className="py-1">{p}</td>
                  <td className="py-1 text-right tabular-nums">{v.toLocaleString()}</td>
                </tr>
              ))}
              <tr>
                <td className="py-1 text-slate-500">Total valid</td>
                <td className="py-1 text-right tabular-nums">
                  {unit.consensus_data.total_valid_votes.toLocaleString()}
                </td>
              </tr>
              <tr>
                <td className="py-1 text-slate-500">Rejected</td>
                <td className="py-1 text-right tabular-nums">
                  {unit.consensus_data.rejected_ballots.toLocaleString()}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
