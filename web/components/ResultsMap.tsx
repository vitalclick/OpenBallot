'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import { MapboxRenderer } from '@/components/MapboxRenderer';
import { STATUS_COLOURS, type PollingUnitDetail, type VerificationStatus } from '@/lib/types';
import {
  STATUS_DESCRIPTION,
  STATUS_LABEL,
  STATUS_ORDER,
  TIER_META,
  TIER_OF,
  TIER_ORDER,
  type VerificationTier,
} from '@/lib/verification';

// Nigeria's geographic bounding box. Coordinates from Natural Earth.
const NIGERIA_BBOX = { lngMin: 2.5, lngMax: 14.7, latMin: 4.0, latMax: 14.0 };

type GeoFeature = {
  type: 'Feature';
  properties: { name: string; kind: 'country' | 'state'; iso?: string };
  geometry:
    | { type: 'Polygon'; coordinates: number[][][] }
    | { type: 'MultiPolygon'; coordinates: number[][][][] };
};
type GeoCollection = { type: 'FeatureCollection'; features: GeoFeature[] };

// The public result-verification map.
//
// In production this is a Mapbox GL JS choropleth with polling-unit dot
// layers. The runtime requires NEXT_PUBLIC_MAPBOX_TOKEN. To keep the
// scaffold runnable without that token (so investors can see the page on a
// fresh clone), we render an SVG fallback that draws a real Nigeria
// outline plus 36 state boundaries + FCT from /public/nigeria.geo.json.

type Filter =
  | { kind: 'all' }
  | { kind: 'tier'; tier: VerificationTier }
  | { kind: 'status'; status: VerificationStatus };

interface Props { electionId: string }

export function ResultsMap({ electionId }: Props) {
  const [units, setUnits] = useState<PollingUnitDetail[]>([]);
  const [filter, setFilter] = useState<Filter>({ kind: 'all' });
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<PollingUnitDetail | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
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

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return units.filter((u) => {
      if (filter.kind === 'tier' && TIER_OF[u.status] !== filter.tier) return false;
      if (filter.kind === 'status' && u.status !== filter.status) return false;
      if (q && !u.pu_code.toLowerCase().includes(q) && !u.pu_name.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [units, filter, search]);

  const tierCounts = useMemo(() => {
    const counts: Record<VerificationTier, number> = {
      verified: 0, provisional: 0, issue: 0, empty: 0,
    };
    for (const u of units) counts[TIER_OF[u.status]]++;
    return counts;
  }, [units]);

  const statusCounts = useMemo(() => {
    const counts: Partial<Record<VerificationStatus, number>> = {};
    for (const u of units) counts[u.status] = (counts[u.status] ?? 0) + 1;
    return counts;
  }, [units]);

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
      <div ref={containerRef} className="flex flex-col bg-slate-100 min-h-0">
        <TierSummary counts={tierCounts} total={units.length} />
        <FilterBar
          filter={filter}
          onChange={setFilter}
          search={search}
          onSearch={setSearch}
          tierCounts={tierCounts}
          statusCounts={statusCounts}
          showAdvanced={showAdvanced}
          onToggleAdvanced={() => setShowAdvanced((v) => !v)}
        />
        <div className="relative flex-1 min-h-0">
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
        </div>
      </div>
      <aside className="border-l bg-white overflow-y-auto">
        <PUDetailPane unit={selected} />
      </aside>
    </div>
  );
}

function TierSummary({
  counts,
  total,
}: {
  counts: Record<VerificationTier, number>;
  total: number;
}) {
  return (
    <div className="px-3 pt-3">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        {TIER_ORDER.map((tier) => {
          const meta = TIER_META[tier];
          const n = counts[tier];
          const pct = total ? (n / total) * 100 : 0;
          return (
            <div
              key={tier}
              className={`rounded-md border px-3 py-2 ${meta.tone} ${meta.border}`}
            >
              <div className="flex items-center justify-between text-[11px] uppercase tracking-wider font-semibold">
                <span className="flex items-center gap-1.5">
                  <span aria-hidden className="inline-flex w-4 h-4 items-center justify-center rounded-full bg-white/70 text-[10px] font-bold">
                    {meta.glyph}
                  </span>
                  {meta.label}
                </span>
                <span className="tabular-nums opacity-70">{pct.toFixed(0)}%</span>
              </div>
              <div className="mt-0.5 text-lg font-semibold tabular-nums">
                {n.toLocaleString()}
              </div>
              <div className="text-[11px] opacity-75 leading-snug">{meta.tagline}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FilterBar({
  filter,
  onChange,
  search,
  onSearch,
  tierCounts,
  statusCounts,
  showAdvanced,
  onToggleAdvanced,
}: {
  filter: Filter;
  onChange: (f: Filter) => void;
  search: string;
  onSearch: (v: string) => void;
  tierCounts: Record<VerificationTier, number>;
  statusCounts: Partial<Record<VerificationStatus, number>>;
  showAdvanced: boolean;
  onToggleAdvanced: () => void;
}) {
  const isAll = filter.kind === 'all';
  return (
    <div className="m-3 mb-2 bg-white rounded-md shadow-sm border border-slate-200">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <span className="text-xs font-medium text-slate-500 mr-1">Show:</span>
        <button
          onClick={() => onChange({ kind: 'all' })}
          className={`px-2.5 py-1 text-xs rounded-full border ${
            isAll
              ? 'bg-slate-900 text-white border-slate-900'
              : 'border-slate-200 hover:bg-slate-50'
          }`}
        >
          All units
        </button>
        {TIER_ORDER.map((tier) => {
          const meta = TIER_META[tier];
          const active = filter.kind === 'tier' && filter.tier === tier;
          return (
            <button
              key={tier}
              onClick={() => onChange({ kind: 'tier', tier })}
              className={`px-2.5 py-1 text-xs rounded-full border inline-flex items-center gap-1.5 ${
                active
                  ? 'bg-slate-900 text-white border-slate-900'
                  : `${meta.border} ${meta.tone} hover:brightness-95`
              }`}
              title={meta.tagline}
            >
              <span aria-hidden>{meta.glyph}</span>
              <span>{meta.label}</span>
              <span className="tabular-nums opacity-70">{tierCounts[tier]}</span>
            </button>
          );
        })}

        <div className="ml-auto flex items-center gap-2">
          <label className="relative">
            <span className="sr-only">Search polling unit</span>
            <input
              type="search"
              value={search}
              onChange={(e) => onSearch(e.target.value)}
              placeholder="Find PU code or name…"
              className="text-xs border border-slate-200 rounded-md pl-7 pr-2 py-1 w-44 sm:w-56 focus:outline-none focus:ring-1 focus:ring-slate-400"
            />
            <span aria-hidden className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 text-xs">⌕</span>
          </label>
          <button
            onClick={onToggleAdvanced}
            className="text-xs text-slate-500 hover:text-slate-800"
          >
            {showAdvanced ? 'Hide detail' : 'More detail'}
          </button>
        </div>
      </div>

      {showAdvanced && (
        <div className="border-t border-slate-100 px-3 py-2 flex flex-wrap gap-1">
          {STATUS_ORDER.map((s) => {
            const active = filter.kind === 'status' && filter.status === s;
            const n = statusCounts[s] ?? 0;
            return (
              <button
                key={s}
                onClick={() => onChange({ kind: 'status', status: s })}
                className={`px-2 py-1 text-xs rounded inline-flex items-center gap-1.5 ${
                  active ? 'bg-slate-900 text-white' : 'hover:bg-slate-50'
                }`}
                title={STATUS_DESCRIPTION[s]}
              >
                <span
                  className="status-dot"
                  style={{ background: STATUS_COLOURS[s] }}
                />
                <span>{STATUS_LABEL[s]}</span>
                <span className="tabular-nums opacity-60">{n}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Legend() {
  return (
    <details
      className="absolute bottom-3 right-3 bg-white rounded-md shadow-sm border border-slate-200 text-xs max-w-[260px]"
      // Open by default on first paint - users need to learn the
      // colour system once and can collapse it after.
      open
    >
      <summary className="px-3 py-2 cursor-pointer font-semibold flex items-center justify-between gap-2">
        <span>What the colours mean</span>
        <span className="text-slate-400 text-[10px]">click to collapse</span>
      </summary>
      <div className="px-3 pb-3 space-y-2">
        {TIER_ORDER.map((tier) => {
          const meta = TIER_META[tier];
          const statuses = STATUS_ORDER.filter((s) => TIER_OF[s] === tier);
          return (
            <div key={tier}>
              <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider font-semibold text-slate-500">
                <span aria-hidden>{meta.glyph}</span>
                <span>{meta.label}</span>
              </div>
              <div className="mt-1 space-y-0.5">
                {statuses.map((s) => (
                  <div key={s} className="flex items-start gap-2" title={STATUS_DESCRIPTION[s]}>
                    <span
                      className="status-dot mt-1 shrink-0"
                      style={{ background: STATUS_COLOURS[s] }}
                    />
                    <div className="leading-snug">
                      <div>{STATUS_LABEL[s]}</div>
                      <div className="text-slate-500 text-[11px]">{STATUS_DESCRIPTION[s]}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </details>
  );
}

function SvgFallback({
  units,
  onSelect,
}: {
  units: PollingUnitDetail[];
  onSelect: (u: PollingUnitDetail) => void;
}) {
  const W = 1000, H = 700;
  const { lngMin, lngMax, latMin, latMax } = NIGERIA_BBOX;
  const toX = (lng: number) => ((lng - lngMin) / (lngMax - lngMin)) * W;
  const toY = (lat: number) => H - ((lat - latMin) / (latMax - latMin)) * H;

  const [geo, setGeo] = useState<GeoCollection | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/nigeria.geo.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!cancelled && j) setGeo(j as GeoCollection); })
      .catch(() => {/* fall back to bare background */});
    return () => { cancelled = true; };
  }, []);

  const ringToPath = (ring: number[][]) =>
    ring
      .map(([lng, lat], i) => `${i === 0 ? 'M' : 'L'}${toX(lng).toFixed(1)} ${toY(lat).toFixed(1)}`)
      .join(' ') + ' Z';

  const featureToPath = (f: GeoFeature) => {
    const polys =
      f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    return polys.map((poly) => poly.map(ringToPath).join(' ')).join(' ');
  };

  const states = geo?.features.filter((f) => f.properties.kind === 'state') ?? [];
  const country = geo?.features.find((f) => f.properties.kind === 'country');

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-full" preserveAspectRatio="xMidYMid meet">
      <defs>
        <linearGradient id="ng-land" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#f8fbf6" />
          <stop offset="100%" stopColor="#eef4ea" />
        </linearGradient>
        <filter id="ng-shadow" x="-5%" y="-5%" width="110%" height="110%">
          <feGaussianBlur in="SourceAlpha" stdDeviation="2" />
          <feOffset dx="0" dy="1" />
          <feComponentTransfer><feFuncA type="linear" slope="0.25" /></feComponentTransfer>
          <feMerge><feMergeNode /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <rect x={0} y={0} width={W} height={H} fill="#e6eef5" />

      {country && (
        <path
          d={featureToPath(country)}
          fill="url(#ng-land)"
          stroke="none"
          filter="url(#ng-shadow)"
        />
      )}

      {states.map((s) => (
        <path
          key={s.properties.iso ?? s.properties.name}
          d={featureToPath(s)}
          fill="none"
          stroke="#94a3b8"
          strokeWidth={0.6}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        >
          <title>{s.properties.name}</title>
        </path>
      ))}

      {country && (
        <path
          d={featureToPath(country)}
          fill="none"
          stroke="#475569"
          strokeWidth={1.4}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      )}

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
      <div className="p-6 text-sm text-slate-500 space-y-3">
        <p className="font-medium text-slate-700">No polling unit selected</p>
        <p>
          Click a dot on the map to inspect a polling unit. The panel will show its
          EC8A submissions, extracted figures, and what every source reported.
        </p>
        <div className="pt-2 border-t text-xs space-y-1">
          <p className="font-medium text-slate-700">Tip</p>
          <p>
            Filter by <em>Needs review</em> to see only the units where independent
            sources disagree or conflict with INEC.
          </p>
        </div>
      </div>
    );
  }
  const tier = TIER_OF[unit.status];
  const meta = TIER_META[tier];
  return (
    <div className="p-5">
      <div className="text-xs uppercase text-slate-500 tracking-wider">{unit.state_code}</div>
      <h2 className="font-semibold text-lg leading-tight">{unit.pu_name}</h2>
      <div className="mt-1 text-xs text-slate-500">PU {unit.pu_code}</div>

      <div
        className={`mt-3 inline-flex items-center gap-2 px-2 py-1 rounded text-xs font-medium border ${meta.tone} ${meta.border}`}
      >
        <span aria-hidden>{meta.glyph}</span>
        <span
          className="status-dot"
          style={{ background: STATUS_COLOURS[unit.status] }}
        />
        <span>{STATUS_LABEL[unit.status]}</span>
      </div>
      <p className="mt-2 text-xs text-slate-500 leading-snug">
        {STATUS_DESCRIPTION[unit.status]}
      </p>

      <a
        href={`/en/pu/${encodeURIComponent(unit.pu_code)}`}
        className="mt-3 text-xs text-blue-700 hover:underline inline-block"
      >
        Open full polling unit detail →
      </a>

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
