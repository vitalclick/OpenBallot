'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import { MapboxRenderer } from '@/components/MapboxRenderer';
import { STATUS_COLOURS, type PollingUnitDetail, type VerificationStatus } from '@/lib/types';

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

// The public results map.
//
// In production this is a Mapbox GL JS choropleth with polling-unit dot
// layers. The runtime requires NEXT_PUBLIC_MAPBOX_TOKEN. To keep the
// scaffold runnable without that token (so investors can see the page on a
// fresh clone), we render an SVG fallback that draws a real Nigeria
// outline plus 36 state boundaries + FCT from /public/nigeria.geo.json.
// That file is extracted from Natural Earth (public domain): the country
// outline is the 50m admin-0 layer and the state boundaries are the 10m
// admin-1 layer, with coordinates rounded to 4 decimals (~11 m). The
// data binding and interaction layer are identical to the real map, so
// swapping the renderer is a one-file change.

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
      <div ref={containerRef} className="flex flex-col bg-slate-100">
        <FilterBar value={filter} onChange={setFilter} />
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
    <div className="m-3 mb-4 bg-white rounded-md shadow px-2 py-1 flex flex-wrap gap-1">
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
    <div className="absolute bottom-3 right-3 bg-white rounded-md shadow p-3 text-xs">
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
