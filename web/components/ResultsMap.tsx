'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { AggregateSymbols } from '@/components/AggregateSymbols';
import { MapboxRenderer } from '@/components/MapboxRenderer';
import {
  aggregateLevelFor,
  ascend,
  COUNTRY_FOCUS,
  descend,
  focusToParams,
  type MapFocus,
} from '@/lib/map-focus';
import {
  STATUS_COLOURS,
  type PollingUnitDetail,
  type RegionAggregate,
  type VerificationStatus,
} from '@/lib/types';

// Nigeria's geographic bounding box. Coordinates from Natural Earth.
const NIGERIA_BBOX = { lngMin: 2.5, lngMax: 14.7, latMin: 4.0, latMax: 14.0 };

type Geom =
  | { type: 'Polygon'; coordinates: number[][][] }
  | { type: 'MultiPolygon'; coordinates: number[][][][] };

type GeoFeature = {
  type: 'Feature';
  properties: { name: string; kind: 'country' | 'state'; iso?: string };
  geometry: Geom;
};
type GeoCollection = { type: 'FeatureCollection'; features: GeoFeature[] };

// The public results map.
//
// Rendering hierarchy (see lib/map-focus.ts):
//   country -> proportional symbols at state centroids (37 circles)
//   state   -> proportional symbols at LGA centroids (~20-60)
//   lga     -> proportional symbols at ward centroids (~10-25)
//   ward    -> one dot per polling unit (5..~282)
//
// The "13,325 dots on Lagos" anti-pattern is gone: PU dots only appear
// once the user has drilled into a specific ward.

const STATUS_LABEL: Record<VerificationStatus, string> = {
  no_data: 'No data',
  single_source: 'Single source',
  inec_published: 'INEC published',
  consensus: 'Consensus',
  discrepancy: 'Discrepancy',
  inec_confirmed: 'INEC confirmed',
  inec_conflict: 'INEC conflict',
};

const ELECTION_OPTIONS: Array<{ slug: string; label: string }> = [
  { slug: 'presidential', label: 'Presidential Election' },
  { slug: 'senate',       label: 'Senate' },
  { slug: 'reps',         label: 'House of Representatives' },
  { slug: 'governorship', label: 'Gubernatorial' },
  { slug: 'stha',         label: 'State House of Assembly' },
];

const YEAR_OPTIONS = [2027, 2023, 2019, 2015, 2011];

interface Props { defaultElectionId: string }

export function ResultsMap({ defaultElectionId }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const defaults = useMemo(() => {
    const [year, slug] = defaultElectionId.split('-');
    return { year: Number(year) || 2027, election: slug || 'presidential' };
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

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-4 h-full">
      <FiltersPanel year={year} election={election} onChange={setFilter} />
      <MapPanel electionId={electionId} />
    </div>
  );
}

function MapPanel({ electionId }: { electionId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [focus, setFocusState] = useState<MapFocus>(COUNTRY_FOCUS);
  // States are cheap (37 rows) - cache them so the state finder works
  // regardless of which level the user is currently viewing.
  const [statesIndex, setStatesIndex] = useState<RegionAggregate[]>([]);
  const [aggregates, setAggregates] = useState<RegionAggregate[]>([]);
  const [units, setUnits] = useState<PollingUnitDetail[]>([]);
  const [statusFilter, setStatusFilter] = useState<VerificationStatus | 'all'>('all');
  const [selected, setSelected] = useState<PollingUnitDetail | null>(null);
  const [selectedRegion, setSelectedRegion] = useState<RegionAggregate | null>(null);
  const mapboxToken =
    typeof window === 'undefined' ? undefined : process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

  // Push focus into the URL so refresh / share preserves the view.
  const setFocus = useCallback((next: MapFocus) => {
    setFocusState(next);
    setSelectedRegion(null);
    const params = new URLSearchParams(searchParams.toString());
    for (const k of ['state', 'lga', 'ward']) params.delete(k);
    for (const [k, v] of Object.entries(focusToParams(next))) params.set(k, v);
    router.replace(`?${params.toString()}`, { scroll: false });
  }, [router, searchParams]);

  // States list cached separately for the state finder dropdown.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/v1/elections/${electionId}/aggregates?level=state`)
      .then((r) => r.json())
      .then((j) => { if (!cancelled) setStatesIndex(j.data ?? []); })
      .catch(() => { if (!cancelled) setStatesIndex([]); });
    return () => { cancelled = true; };
  }, [electionId]);

  // Fetch aggregates for the current level. Skipped at ward focus -
  // ward shows raw PUs instead.
  useEffect(() => {
    const level = aggregateLevelFor(focus);
    if (!level) { setAggregates([]); return; }
    let cancelled = false;
    const parent =
      focus.level === 'country' ? '' :
      focus.level === 'state'   ? `&parent=${encodeURIComponent(focus.state_code)}` :
      focus.level === 'lga'     ? `&parent=${encodeURIComponent(focus.lga_code)}` : '';
    fetch(`/api/v1/elections/${electionId}/aggregates?level=${level}${parent}`)
      .then((r) => r.json())
      .then((j) => { if (!cancelled) setAggregates(j.data ?? []); })
      .catch(() => { if (!cancelled) setAggregates([]); });
    return () => { cancelled = true; };
  }, [electionId, focus]);

  // Fetch raw PUs only when the user has drilled into a ward.
  useEffect(() => {
    if (focus.level !== 'ward') { setUnits([]); return; }
    let cancelled = false;
    const params = new URLSearchParams({ ward: focus.ward_code });
    fetch(`/api/v1/elections/${electionId}/units?${params.toString()}`)
      .then((r) => r.json())
      .then((j) => { if (!cancelled) setUnits(j.data ?? []); })
      .catch(() => { if (!cancelled) setUnits([]); });
    return () => { cancelled = true; };
  }, [electionId, focus]);

  const filteredUnits = useMemo(() => {
    if (statusFilter === 'all') return units;
    return units.filter((u) => u.status === statusFilter);
  }, [units, statusFilter]);

  // Realtime: subscribe to verification_status changes via SSE. Updates
  // both the per-PU status (when the user is at ward focus) and the
  // aggregate counts. For aggregates we simply refetch when an update
  // arrives - it's cheap and avoids bookkeeping bugs.
  useEffect(() => {
    const es = new EventSource(`/api/v1/elections/${electionId}/stream`);
    es.addEventListener('verified_result', (ev: MessageEvent) => {
      try {
        const update = JSON.parse(ev.data) as { pu_code: string; status: VerificationStatus };
        setUnits((prev) =>
          prev.map((u) => (u.pu_code === update.pu_code ? { ...u, status: update.status } : u))
        );
      } catch {/* ignore */}
    });
    es.onerror = () => es.close();
    return () => es.close();
  }, [electionId]);

  return (
    <div className="grid grid-cols-1 md:grid-cols-[1fr_360px] h-full bg-slate-100 rounded-md overflow-hidden border border-slate-200">
      <div className="flex flex-col bg-slate-100 min-h-0">
        <FilterBar
          value={statusFilter}
          onChange={setStatusFilter}
          disabled={focus.level !== 'ward'}
        />
        <StateFinder
          states={statesIndex}
          focus={focus}
          onJump={(s) => setFocus({ level: 'state', state_code: s.code, state_name: s.name })}
        />
        <Breadcrumb focus={focus} onFocus={setFocus} />
        <div className="relative flex-1 min-h-0">
          {mapboxToken ? (
            <MapboxRenderer
              electionId={electionId}
              token={mapboxToken}
              focus={focus}
              onFocus={setFocus}
              onSelectPU={setSelected}
            />
          ) : (
            <SvgFallback
              focus={focus}
              aggregates={aggregates}
              units={filteredUnits}
              onFocus={setFocus}
              onSelectRegion={setSelectedRegion}
              onSelectPU={setSelected}
            />
          )}
          <Legend level={focus.level} regions={aggregates} />
        </div>
      </div>
      <aside className="border-l bg-white overflow-y-auto">
        {selected
          ? <PUDetailPane unit={selected} />
          : <RegionDetailPane focus={focus} region={selectedRegion} aggregates={aggregates} />}
      </aside>
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
    <aside className="space-y-3 lg:sticky lg:top-20 lg:self-start p-3 lg:p-0">
      <FilterCard step="1" colour="bg-ng-600" label="Select Election Year">
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
      <FilterCard step="2" colour="bg-ng-800" label="Select Election">
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

function FilterBar({
  value,
  onChange,
  disabled,
}: {
  value: VerificationStatus | 'all';
  onChange: (v: VerificationStatus | 'all') => void;
  disabled: boolean;
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
    <div className={`m-3 mb-2 bg-white rounded-md shadow px-2 py-1 flex flex-wrap gap-1 items-center ${disabled ? 'opacity-50' : ''}`}>
      <span className="text-[10px] uppercase tracking-wider text-slate-500 mr-1 px-1">
        Status
      </span>
      {opts.map((s) => (
        <button
          key={s}
          disabled={disabled}
          onClick={() => onChange(s)}
          className={`px-2 py-1 text-xs rounded ${
            value === s ? 'bg-slate-900 text-white' : 'hover:bg-slate-100'
          } disabled:cursor-not-allowed`}
          title={disabled ? 'Drill into a ward to filter individual polling units' : undefined}
        >
          {s === 'all' ? 'All' : STATUS_LABEL[s as VerificationStatus]}
        </button>
      ))}
    </div>
  );
}

function StateFinder({
  states,
  focus,
  onJump,
}: {
  states: RegionAggregate[];
  focus: MapFocus;
  onJump: (s: RegionAggregate) => void;
}) {
  // The select shows "— jump to state —" when the user is not currently
  // focused on a state, otherwise pre-selects the focused state.
  const value = focus.level === 'country' ? '' : focus.state_code;
  return (
    <div className="mx-3 mb-2 flex items-center gap-2 text-xs text-slate-600">
      <label className="text-[10px] uppercase tracking-wider text-slate-500">
        Jump to state
      </label>
      <select
        className="border border-slate-200 rounded px-2 py-1 text-xs bg-white"
        value={value}
        onChange={(e) => {
          const s = states.find((x) => x.code === e.target.value);
          if (s) onJump(s);
        }}
      >
        <option value="" disabled>— select —</option>
        {[...states]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((s) => (
            <option key={s.code} value={s.code}>
              {s.name} ({s.pu_count.toLocaleString()} PUs)
            </option>
          ))}
      </select>
    </div>
  );
}

function Breadcrumb({
  focus,
  onFocus,
}: {
  focus: MapFocus;
  onFocus: (f: MapFocus) => void;
}) {
  // Build the trail from country down to the current level so each
  // segment is clickable.
  const trail: Array<{ label: string; target: MapFocus }> = [
    { label: 'Nigeria', target: COUNTRY_FOCUS },
  ];
  if (focus.level !== 'country') {
    trail.push({
      label: focus.state_name,
      target: { level: 'state', state_code: focus.state_code, state_name: focus.state_name },
    });
  }
  if (focus.level === 'lga' || focus.level === 'ward') {
    trail.push({
      label: focus.lga_name,
      target: {
        level: 'lga',
        state_code: focus.state_code, state_name: focus.state_name,
        lga_code: focus.lga_code, lga_name: focus.lga_name,
      },
    });
  }
  if (focus.level === 'ward') {
    trail.push({ label: focus.ward_name, target: focus });
  }
  return (
    <div className="mx-3 mb-2 flex items-center gap-2 text-xs text-slate-600">
      {trail.map((t, i) => (
        <span key={i} className="flex items-center gap-2">
          {i > 0 && <span className="text-slate-300">›</span>}
          {i === trail.length - 1 ? (
            <span className="text-slate-800 font-medium">{t.label}</span>
          ) : (
            <button
              onClick={() => onFocus(t.target)}
              className="text-ng-700 hover:underline"
            >
              {t.label}
            </button>
          )}
        </span>
      ))}
      {focus.level !== 'country' && (
        <button
          onClick={() => onFocus(ascend(focus))}
          className="ml-auto text-slate-500 hover:text-slate-800"
          aria-label="Zoom out one level"
        >
          ← Back
        </button>
      )}
    </div>
  );
}

function Legend({ level, regions }: { level: MapFocus['level']; regions: RegionAggregate[] }) {
  if (level === 'ward') {
    return (
      <div className="absolute bottom-3 right-3 bg-white rounded-md shadow p-3 text-xs">
        <div className="font-semibold mb-1">Polling unit status</div>
        {(Object.keys(STATUS_COLOURS) as VerificationStatus[]).map((s) => (
          <div key={s} className="flex items-center gap-2 py-0.5">
            <span className="status-dot" style={{ background: STATUS_COLOURS[s] }} />
            <span>{STATUS_LABEL[s]}</span>
          </div>
        ))}
      </div>
    );
  }
  // Proportional-symbol legend at country/state/lga levels.
  const counts = regions.map((r) => r.pu_count).filter((n) => n > 0);
  const max = counts.length ? Math.max(...counts) : 0;
  const ticks = legendTicks(max);
  return (
    <div className="absolute bottom-3 right-3 bg-white rounded-md shadow p-3 text-xs space-y-2 max-w-[220px]">
      <div>
        <div className="font-semibold mb-1">Polling units</div>
        <div className="flex items-end gap-3 h-12">
          {ticks.map((n) => (
            <div key={n} className="flex flex-col items-center">
              <span
                className="inline-block rounded-full border border-slate-700/50"
                style={{
                  width: legendRadiusPx(n, max) * 2,
                  height: legendRadiusPx(n, max) * 2,
                  background: 'rgba(74, 222, 128, 0.6)',
                }}
              />
              <span className="mt-1 text-[10px] text-slate-600">{n.toLocaleString()}</span>
            </div>
          ))}
        </div>
      </div>
      <div>
        <div className="font-semibold mb-1">% verified</div>
        <div className="flex items-center gap-1">
          {[
            ['#e2e8f0', '0'],
            ['#fde68a', '<50'],
            ['#a3e635', '<50'],
            ['#4ade80', '<85'],
            ['#16a34a', '≥85'],
          ].map(([c, l], i) => (
            <span key={i} className="flex items-center gap-1">
              <span
                className="inline-block w-3 h-3 rounded-sm border border-slate-300"
                style={{ background: c as string }}
              />
              <span className="text-[10px] text-slate-600">{l}</span>
            </span>
          ))}
        </div>
        <div className="mt-1 flex items-center gap-2 text-[10px] text-slate-600">
          <span className="inline-block w-3 h-3 rounded-full border-2" style={{ borderColor: '#dc2626' }} />
          INEC conflict
          <span className="inline-block w-3 h-3 rounded-full border-2 ml-2" style={{ borderColor: '#f97316' }} />
          Discrepancy
        </div>
      </div>
    </div>
  );
}

function legendTicks(max: number): number[] {
  if (max <= 0) return [10];
  // Pick "nice" round values at roughly 1, 0.3, 0.07 of max.
  const round = (n: number) => {
    if (n >= 10000) return Math.round(n / 1000) * 1000;
    if (n >= 1000)  return Math.round(n / 100) * 100;
    if (n >= 100)   return Math.round(n / 10) * 10;
    if (n >= 10)    return Math.round(n);
    return Math.max(1, Math.round(n));
  };
  const big = round(max);
  const mid = round(max * 0.3);
  const small = round(max * 0.07);
  return [...new Set([small, mid, big])].filter((n) => n > 0).sort((a, b) => a - b);
}
function legendRadiusPx(n: number, max: number): number {
  if (max <= 0) return 4;
  const t = Math.sqrt(n) / Math.sqrt(max);
  return 4 + t * 14;
}

// Strip the "NG-" ISO prefix so the GeoJSON iso (e.g. "NG-LA") matches
// the two-letter state_code on PollingUnitDetail.
function isoToStateCode(iso?: string): string | null {
  if (!iso) return null;
  return iso.startsWith('NG-') ? iso.slice(3) : iso;
}

const W = 1000, H = 700;
function toX(lng: number): number {
  return ((lng - NIGERIA_BBOX.lngMin) / (NIGERIA_BBOX.lngMax - NIGERIA_BBOX.lngMin)) * W;
}
function toY(lat: number): number {
  return H - ((lat - NIGERIA_BBOX.latMin) / (NIGERIA_BBOX.latMax - NIGERIA_BBOX.latMin)) * H;
}
function geomBbox(g: Geom): [number, number, number, number] {
  let lngMin = Infinity, lngMax = -Infinity, latMin = Infinity, latMax = -Infinity;
  const walk = (v: unknown) => {
    if (Array.isArray(v)) {
      if (typeof v[0] === 'number') {
        const [lng, lat] = v as number[];
        if (lng < lngMin) lngMin = lng;
        if (lng > lngMax) lngMax = lng;
        if (lat < latMin) latMin = lat;
        if (lat > latMax) latMax = lat;
      } else (v as unknown[]).forEach(walk);
    }
  };
  walk(g.coordinates);
  return [lngMin, latMin, lngMax, latMax];
}
function bboxToViewBox(
  [lngMin, latMin, lngMax, latMax]: number[]
): [number, number, number, number] {
  const x1 = toX(lngMin), x2 = toX(lngMax);
  const y1 = toY(latMax),  y2 = toY(latMin);
  const w = x2 - x1, h = y2 - y1;
  const pad = Math.max(w, h) * 0.08;
  return [x1 - pad, y1 - pad, w + pad * 2, h + pad * 2];
}

function pointsBbox(pts: Array<{ lng: number; lat: number }>): [number, number, number, number] | null {
  if (pts.length === 0) return null;
  let lngMin = Infinity, lngMax = -Infinity, latMin = Infinity, latMax = -Infinity;
  for (const p of pts) {
    if (p.lng < lngMin) lngMin = p.lng;
    if (p.lng > lngMax) lngMax = p.lng;
    if (p.lat < latMin) latMin = p.lat;
    if (p.lat > latMax) latMax = p.lat;
  }
  // Pad single-point bboxes so the symbol isn't a 0x0 viewport.
  if (lngMax - lngMin < 0.05) { lngMin -= 0.05; lngMax += 0.05; }
  if (latMax - latMin < 0.05) { latMin -= 0.05; latMax += 0.05; }
  return [lngMin, latMin, lngMax, latMax];
}

function SvgFallback({
  focus,
  aggregates,
  units,
  onFocus,
  onSelectRegion,
  onSelectPU,
}: {
  focus: MapFocus;
  aggregates: RegionAggregate[];
  units: PollingUnitDetail[];
  onFocus: (f: MapFocus) => void;
  onSelectRegion: (r: RegionAggregate | null) => void;
  onSelectPU: (u: PollingUnitDetail) => void;
}) {
  const [geo, setGeo] = useState<GeoCollection | null>(null);
  const [zoomScale, setZoomScale] = useState(1);
  const [panOffset, setPanOffset] = useState<[number, number]>([0, 0]);
  const svgRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/nigeria.geo.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!cancelled && j) setGeo(j as GeoCollection); })
      .catch(() => {/* fall back to bare background */});
    return () => { cancelled = true; };
  }, []);

  // Reset manual zoom/pan whenever the user drills in or out.
  useEffect(() => { setZoomScale(1); setPanOffset([0, 0]); }, [focus]);

  const ringToPath = (ring: number[][]) =>
    ring
      .map(([lng, lat], i) => `${i === 0 ? 'M' : 'L'}${toX(lng).toFixed(1)} ${toY(lat).toFixed(1)}`)
      .join(' ') + ' Z';

  const featureToPath = (f: GeoFeature) => {
    const polys =
      f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    return polys.map((poly) => poly.map(ringToPath).join(' ')).join(' ');
  };

  const states = useMemo(
    () => geo?.features.filter((f) => f.properties.kind === 'state') ?? [],
    [geo]
  );
  const country = useMemo(
    () => geo?.features.find((f) => f.properties.kind === 'country') ?? null,
    [geo]
  );

  // viewBox = bbox of country / focused state / focused LGA / focused ward.
  // For LGA & ward we don't have boundary polygons in the SVG fallback,
  // so we derive a bbox from the aggregate / unit centroids in scope.
  const viewBox = useMemo<[number, number, number, number]>(() => {
    let bbox: [number, number, number, number] = [
      NIGERIA_BBOX.lngMin, NIGERIA_BBOX.latMin, NIGERIA_BBOX.lngMax, NIGERIA_BBOX.latMax,
    ];
    if (focus.level === 'state' || focus.level === 'lga' || focus.level === 'ward') {
      const s = states.find((f) => isoToStateCode(f.properties.iso) === focus.state_code);
      if (s) bbox = geomBbox(s.geometry);
    }
    if (focus.level === 'lga' || focus.level === 'ward') {
      const pts = aggregates.map((a) => a.centroid);
      const inferred = pointsBbox(pts);
      if (inferred) bbox = inferred;
    }
    if (focus.level === 'ward') {
      const pts = units.map((u) => u.coordinates);
      const inferred = pointsBbox(pts);
      if (inferred) bbox = inferred;
    }
    const [vx, vy, vw, vh] = bboxToViewBox(bbox);
    const cx = vx + vw / 2, cy = vy + vh / 2;
    const w = vw / zoomScale, h = vh / zoomScale;
    return [cx - w / 2 + panOffset[0], cy - h / 2 + panOffset[1], w, h];
  }, [focus, states, aggregates, units, zoomScale, panOffset]);

  // Drag-to-pan with click-vs-drag disambiguation.
  const DRAG_THRESHOLD = 5;
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{
    startX: number; startY: number; px: number; py: number;
    moved: boolean; pointerId: number;
  } | null>(null);
  const didDragRef = useRef(false);

  const onWheel = useCallback((e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    setZoomScale((z) => Math.min(40, Math.max(1, z * factor)));
  }, []);
  const onPointerDown = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    dragRef.current = {
      startX: e.clientX, startY: e.clientY,
      px: panOffset[0], py: panOffset[1],
      moved: false, pointerId: e.pointerId,
    };
    didDragRef.current = false;
  }, [panOffset]);
  const onPointerMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (!dragRef.current || !svgRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    if (Math.hypot(dx, dy) <= DRAG_THRESHOLD) return;
    if (!dragRef.current.moved) {
      svgRef.current.setPointerCapture(dragRef.current.pointerId);
      setDragging(true);
    }
    dragRef.current.moved = true;
    const rect = svgRef.current.getBoundingClientRect();
    const scale = viewBox[2] / rect.width;
    setPanOffset([dragRef.current.px - dx * scale, dragRef.current.py - dy * scale]);
  }, [viewBox]);
  const onPointerUp = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (svgRef.current?.hasPointerCapture?.(e.pointerId)) {
      svgRef.current.releasePointerCapture(e.pointerId);
    }
    didDragRef.current = !!dragRef.current?.moved;
    dragRef.current = null;
    setDragging(false);
  }, []);
  const guarded = useCallback(
    <T,>(fn: (arg: T) => void) =>
      (arg: T) => { if (!didDragRef.current) fn(arg); },
    []
  );

  // Pixel-per-viewBox-unit, used by the aggregate-symbol layer to keep
  // circle sizes roughly constant on screen as the user manually zooms.
  const [pxPerUnit, setPxPerUnit] = useState(1);
  useEffect(() => {
    const update = () => {
      if (!svgRef.current) return;
      const rect = svgRef.current.getBoundingClientRect();
      setPxPerUnit(rect.width / Math.max(viewBox[2], 0.0001));
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [viewBox]);

  return (
    <svg
      ref={svgRef}
      viewBox={viewBox.join(' ')}
      className="w-full h-full select-none touch-none"
      preserveAspectRatio="xMidYMid meet"
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      style={{ cursor: dragging ? 'grabbing' : 'grab' }}
    >
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
      <rect
        x={NIGERIA_BBOX.lngMin}
        y={NIGERIA_BBOX.latMin}
        width={W}
        height={H}
        fill="#e6eef5"
      />

      {country && (
        <path
          d={featureToPath(country)}
          fill="url(#ng-land)"
          stroke="none"
          filter="url(#ng-shadow)"
        />
      )}

      {states.map((s) => {
        const code = isoToStateCode(s.properties.iso);
        const isFocused = focus.level !== 'country' && focus.state_code === code;
        const isOtherFocused = focus.level !== 'country' && !isFocused;
        // States are only directly clickable when we're at country focus.
        // Once drilled in, the LGA/ward selection happens via aggregate
        // symbols overlaid on the focused state.
        const clickable = focus.level === 'country';
        return (
          <path
            key={s.properties.iso ?? s.properties.name}
            d={featureToPath(s)}
            fill={isFocused ? '#dbeafe' : 'transparent'}
            fillOpacity={isOtherFocused ? 0.1 : 1}
            stroke={isFocused ? '#1d4ed8' : '#94a3b8'}
            strokeWidth={isFocused ? 1.4 : 0.6}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
            style={{ cursor: clickable ? 'pointer' : 'default' }}
            onClick={
              clickable
                ? guarded(() => {
                    if (!code) return;
                    onFocus({ level: 'state', state_code: code, state_name: s.properties.name });
                  })
                : undefined
            }
          >
            <title>{s.properties.name}</title>
          </path>
        );
      })}

      {country && (
        <path
          d={featureToPath(country)}
          fill="none"
          stroke="#475569"
          strokeWidth={1.4}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
          pointerEvents="none"
        />
      )}

      {/*
        Level-aware overlay:
          - country / state / lga: proportional symbols at child centroids
          - ward: individual polling unit dots (always small enough to read)
      */}
      {focus.level !== 'ward' && (
        <AggregateSymbols
          regions={aggregates}
          project={(lng, lat) => ({ x: toX(lng), y: toY(lat) })}
          pxPerUnit={pxPerUnit}
          onSelect={guarded((r) => {
            onSelectRegion(r);
            if (r.level === 'state' || r.level === 'lga') {
              onFocus(descend(focus, { code: r.code, name: r.name, state_code: r.state_code }));
            } else if (r.level === 'ward') {
              onFocus(descend(focus, { code: r.code, name: r.name, state_code: r.state_code }));
            }
          })}
        />
      )}

      {focus.level === 'ward' && units.map((u) => (
        <circle
          key={u.pu_code}
          cx={toX(u.coordinates.lng)}
          cy={toY(u.coordinates.lat)}
          r={4 / Math.max(pxPerUnit / 10, 1)}
          fill={STATUS_COLOURS[u.status]}
          stroke="#0f172a"
          strokeOpacity={0.3}
          strokeWidth={0.5}
          vectorEffect="non-scaling-stroke"
          style={{ cursor: 'pointer' }}
          onClick={guarded(() => onSelectPU(u))}
        >
          <title>{u.pu_name} — {STATUS_LABEL[u.status]}</title>
        </circle>
      ))}
    </svg>
  );
}

function RegionDetailPane({
  focus,
  region,
  aggregates,
}: {
  focus: MapFocus;
  region: RegionAggregate | null;
  aggregates: RegionAggregate[];
}) {
  // Default: summarise the currently-focused container (Nigeria total,
  // or whichever state/LGA the user has drilled into).
  const summary = useMemo(() => sumAggregates(aggregates), [aggregates]);
  const r = region;
  return (
    <div className="p-5">
      <div className="text-xs uppercase text-slate-500 tracking-wider">
        {focus.level === 'country' ? 'Nigeria' :
         focus.level === 'state' ? focus.state_name :
         focus.level === 'lga' ? `${focus.state_name} › ${focus.lga_name}` :
         `${focus.lga_name} › ${focus.ward_name}`}
      </div>
      <h2 className="font-semibold text-lg leading-tight">
        {r ? r.name : levelLabelChildren(focus)}
      </h2>
      {!r && (
        <p className="mt-1 text-xs text-slate-500">
          {aggregates.length.toLocaleString()} {childPlural(focus)} •{' '}
          {summary.pu_count.toLocaleString()} polling units
        </p>
      )}
      {r && (
        <p className="mt-1 text-xs text-slate-500">
          {r.pu_count.toLocaleString()} polling units in this {r.level}
        </p>
      )}

      <StatusBar a={r ?? summary} />

      {r?.leader_party && r.leader_share !== null && (
        <div className="mt-3 text-sm">
          Leading party: <span className="font-medium">{r.leader_party}</span>{' '}
          <span className="text-slate-500">({Math.round(r.leader_share * 100)}%)</span>
        </div>
      )}

      {focus.level === 'country' && (
        <div className="mt-4 text-xs text-slate-500 leading-relaxed">
          Click any state to see its LGAs. The 13,325 polling units in Lagos
          State (or 2,244 in Bayelsa) are only revealed once you drill into a
          single ward — keeping the country view readable.
        </div>
      )}
      {focus.level === 'state' && (
        <div className="mt-4 text-xs text-slate-500 leading-relaxed">
          Click any LGA to see its wards. Symbol size is proportional to
          polling unit count; colour shows the share of PUs already verified.
        </div>
      )}
      {focus.level === 'lga' && (
        <div className="mt-4 text-xs text-slate-500 leading-relaxed">
          Click any ward to reveal its individual polling units (usually
          5–282 dots, always readable).
        </div>
      )}
      {focus.level === 'ward' && (
        <div className="mt-4 text-xs text-slate-500 leading-relaxed">
          Click a polling unit dot to view its EC8A submissions and
          verification status.
        </div>
      )}
    </div>
  );
}

function levelLabelChildren(focus: MapFocus): string {
  switch (focus.level) {
    case 'country': return 'All states';
    case 'state':   return 'Local Government Areas';
    case 'lga':     return 'Wards';
    case 'ward':    return 'Polling units';
  }
}
function childPlural(focus: MapFocus): string {
  switch (focus.level) {
    case 'country': return 'states';
    case 'state':   return 'LGAs';
    case 'lga':     return 'wards';
    case 'ward':    return 'polling units';
  }
}

function sumAggregates(rows: RegionAggregate[]): RegionAggregate {
  const out = {
    level: 'state' as const, code: '_sum', name: 'Total', parent_code: null,
    state_code: '', pu_count: 0,
    units_reporting: 0, units_consensus: 0, units_discrepancy: 0,
    units_inec_confirmed: 0, units_inec_conflict: 0,
    units_inec_published: 0, units_single_source: 0,
    centroid: { lng: 0, lat: 0 },
    leader_party: null, leader_share: null,
  };
  for (const r of rows) {
    out.pu_count += r.pu_count;
    out.units_reporting += r.units_reporting;
    out.units_consensus += r.units_consensus;
    out.units_discrepancy += r.units_discrepancy;
    out.units_inec_confirmed += r.units_inec_confirmed;
    out.units_inec_conflict += r.units_inec_conflict;
    out.units_inec_published += r.units_inec_published;
    out.units_single_source += r.units_single_source;
  }
  return out;
}

function StatusBar({ a }: { a: RegionAggregate }) {
  if (a.pu_count === 0) {
    return (
      <div className="mt-3 text-xs text-slate-500">No polling units in scope.</div>
    );
  }
  const segments: Array<{ label: string; count: number; colour: string }> = [
    { label: 'Consensus',      count: a.units_consensus,      colour: STATUS_COLOURS.consensus },
    { label: 'INEC confirmed', count: a.units_inec_confirmed, colour: STATUS_COLOURS.inec_confirmed },
    { label: 'INEC published', count: a.units_inec_published, colour: STATUS_COLOURS.inec_published },
    { label: 'Single source',  count: a.units_single_source,  colour: STATUS_COLOURS.single_source },
    { label: 'Discrepancy',    count: a.units_discrepancy,    colour: STATUS_COLOURS.discrepancy },
    { label: 'INEC conflict',  count: a.units_inec_conflict,  colour: STATUS_COLOURS.inec_conflict },
  ];
  const sumStatused = segments.reduce((s, x) => s + x.count, 0);
  const noData = Math.max(0, a.pu_count - sumStatused);
  segments.push({ label: 'No data', count: noData, colour: STATUS_COLOURS.no_data });
  return (
    <div className="mt-4">
      <div className="text-xs text-slate-500 mb-1">
        {a.units_reporting.toLocaleString()} / {a.pu_count.toLocaleString()} reporting
      </div>
      <div className="flex h-3 rounded overflow-hidden border border-slate-200">
        {segments.map((s) =>
          s.count > 0 ? (
            <span
              key={s.label}
              title={`${s.label}: ${s.count.toLocaleString()}`}
              style={{ background: s.colour, width: `${(s.count / a.pu_count) * 100}%` }}
            />
          ) : null
        )}
      </div>
      <ul className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        {segments.filter((s) => s.count > 0).map((s) => (
          <li key={s.label} className="flex items-center gap-1.5">
            <span className="status-dot" style={{ background: s.colour }} />
            <span className="text-slate-700">{s.label}</span>
            <span className="ml-auto tabular-nums text-slate-500">
              {s.count.toLocaleString()}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PUDetailPane({ unit }: { unit: PollingUnitDetail | null }) {
  if (!unit) {
    return (
      <div className="p-6 text-sm text-slate-500">
        Click a state to zoom in, then click an LGA, a ward, and finally a
        polling unit to see its EC8A submissions and verification status.
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
