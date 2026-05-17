'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { feature as topoFeature } from 'topojson-client';
import type { Topology, GeometryCollection } from 'topojson-specification';

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
import {
  DEFAULT_PARTY_PALETTE,
  NO_LEADER_FILL,
  leaderFromCandidateVotes,
  partyColour,
  type Party,
  type PartyPalette,
} from '@/lib/party-colours';

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

// LGA GeoJSON (lazy-loaded from /nigeria-lgas.geo.json) so the state
// drill-down shows real LGA polygons matching what /en/results renders,
// instead of just centroid circles.
type LgaFeature = {
  type: 'Feature';
  properties: { name: string; kind: 'lga'; state_code: string | null; state_name: string };
  geometry: Geom;
};
type LgaCollection = { type: 'FeatureCollection'; features: LgaFeature[] };

// Ward GeoJSON fetched on-demand from /api/v1/lgas/{code}/wards once
// the user drills into an LGA. Polygons come from the GRID3 Nigeria
// Operational Wards layer (loaded via scripts/load_ward_boundaries.py).
// Wards without a reconciled polygon arrive with geometry=null; the
// renderer falls back to the proportional-symbol circle for those.
type WardFeature = {
  type: 'Feature';
  properties: {
    ward_code: string;
    name: string;
    lga_code: string;
    state_code: string;
    match_confidence: number | null;
    source: string | null;
  };
  geometry: Geom | null;
};
type WardCollection = { type: 'FeatureCollection'; features: WardFeature[] };


// The public results map.
//
// Rendering hierarchy (see lib/map-focus.ts):
//   country -> state polygons (37) from nigeria.topo.json
//   state   -> LGA polygons (~20-60) from the same TopoJSON file
//   lga     -> ward polygons (~10-25) from /api/v1/lgas/{code}/wards,
//              with proportional-symbol fallback for any ward whose
//              GRID3 reconciliation hasn't produced a polygon yet
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
    <MapPanel electionId={electionId}>
      <FiltersPanel year={year} election={election} onChange={setFilter} />
    </MapPanel>
  );
}

function MapPanel({
  electionId,
  children,
}: {
  electionId: string;
  // Rendered above the breadcrumb / filters / detail pane in the left
  // sidebar. The ElectionYear / ElectionType selectors live here.
  children: React.ReactNode;
}) {
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
  // Party palette: fetched once and shared with the map renderer +
  // legend. Region polygons and PU dots are filled with the leader's
  // brand colour. If the API is unreachable we fall back to the
  // hard-coded well-known palette so the map still renders sensibly.
  const [partyPalette, setPartyPalette] = useState<PartyPalette>(DEFAULT_PARTY_PALETTE);
  const [partyList, setPartyList] = useState<Party[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/v1/parties')
      .then((r) => (r.ok ? r.json() : null))
      .then((payload: { data?: Party[] } | null) => {
        if (cancelled || !payload?.data) return;
        const next: PartyPalette = { ...DEFAULT_PARTY_PALETTE };
        for (const p of payload.data) {
          if (p.colour_hex) next[p.code] = p.colour_hex;
        }
        setPartyPalette(next);
        setPartyList(payload.data);
      })
      .catch(() => {/* keep DEFAULT_PARTY_PALETTE */});
    return () => { cancelled = true; };
  }, []);
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
    <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-4 h-full">
      {/* Left sidebar: election selectors, breadcrumb, status filter,
          and the detail pane all stack vertically here so the map gets
          the full remaining width. */}
      <aside className="flex flex-col gap-3 lg:sticky lg:top-20 lg:self-start lg:max-h-[calc(100vh-6rem)] overflow-y-auto p-3 lg:p-0">
        {children}
        <div className="bg-white rounded-md shadow-sm">
          {selected
            ? <PUDetailPane unit={selected} />
            : <RegionDetailPane focus={focus} region={selectedRegion} aggregates={aggregates} />}
        </div>
      </aside>
      {/* Map column: horizontal control bar (state finder + breadcrumb,
          then status filter on a second row) above the map itself. */}
      <div className="flex flex-col gap-2 min-h-0">
        <div className="bg-white rounded-md shadow-sm border border-slate-200 px-3 py-2 flex flex-wrap items-center gap-3">
          <StateFinder
            states={statesIndex}
            focus={focus}
            onJump={(s) => setFocus({ level: 'state', state_code: s.code, state_name: s.name })}
          />
          <div className="h-6 w-px bg-slate-200 hidden sm:block" />
          <Breadcrumb focus={focus} onFocus={setFocus} />
        </div>
        <FilterBar
          value={statusFilter}
          onChange={setStatusFilter}
          disabled={focus.level !== 'ward'}
        />
        <div className="relative flex-1 min-h-[480px] overflow-hidden">
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
              partyPalette={partyPalette}
              onFocus={setFocus}
              onSelectRegion={setSelectedRegion}
              onSelectPU={setSelected}
            />
          )}
          <Legend
            level={focus.level}
            regions={aggregates}
            parties={partyList}
            palette={partyPalette}
          />
        </div>
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
    <div className="space-y-3">
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
    </div>
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
    <div className={`bg-white rounded-md shadow-sm border border-slate-200 px-3 py-2 flex flex-wrap gap-1 items-center ${disabled ? 'opacity-50' : ''}`}>
      <span className="text-[10px] uppercase tracking-wider text-slate-500 mr-2 whitespace-nowrap">
        Status filter
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
    <div className="flex items-center gap-2">
      <label className="text-[10px] uppercase tracking-wider text-slate-500 whitespace-nowrap">
        Jump to state
      </label>
      <select
        className="border border-slate-200 rounded px-2 py-1 text-xs bg-white max-w-[180px]"
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
    <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-600 flex-1 min-w-0">
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

function Legend({
  level, regions, parties, palette,
}: {
  level: MapFocus['level'];
  regions: RegionAggregate[];
  parties: Party[];
  palette: PartyPalette;
}) {
  // Party swatches — used at every focus level. Computed from the
  // parties the API knows about, restricted to ones that actually
  // hold a colour (so the "unknown party" grey doesn't clutter the
  // legend). Kept in the order the API returns (alpha by code).
  const partySwatches = parties.length
    ? parties.filter((p) => p.colour_hex).slice(0, 8)
    : Object.entries(palette).slice(0, 8).map(([code, colour_hex]) => ({
        code, name: code, colour_hex, inec_registered: true,
      } as Party));

  if (level === 'ward') {
    return (
      <div className="absolute bottom-3 right-3 bg-white rounded-md shadow p-3 text-xs space-y-2 max-w-[220px]">
        <div>
          <div className="font-semibold mb-1">Leading party</div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
            {partySwatches.map((p) => (
              <span key={p.code} className="flex items-center gap-2 text-[10px] text-slate-700">
                <span
                  className="inline-block w-3 h-3 rounded-full border border-slate-300"
                  style={{ background: p.colour_hex ?? '#94a3b8' }}
                />
                <span>{p.code}</span>
              </span>
            ))}
            <span className="flex items-center gap-2 text-[10px] text-slate-600">
              <span
                className="inline-block w-3 h-3 rounded-full border border-slate-300"
                style={{ background: NO_LEADER_FILL }}
              />
              <span>No result</span>
            </span>
          </div>
        </div>
        <div>
          <div className="font-semibold mb-1">PU verification</div>
          <div className="flex items-center gap-3 text-[10px] text-slate-600">
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded-full border-2" style={{ borderColor: '#dc2626' }} />
              INEC conflict
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded-full border-2" style={{ borderColor: '#f97316' }} />
              Discrepancy
            </span>
          </div>
        </div>
        <div className="text-[9px] text-slate-400 pt-1 border-t border-slate-100">
          Boundaries © GRID3 (CC BY 4.0)
        </div>
      </div>
    );
  }
  // Proportional-symbol + party-swatch legend at country/state/lga levels.
  const counts = regions.map((r) => r.pu_count).filter((n) => n > 0);
  const max = counts.length ? Math.max(...counts) : 0;
  const ticks = legendTicks(max);
  return (
    <div className="absolute bottom-3 right-3 bg-white rounded-md shadow p-3 text-xs space-y-2 max-w-[240px]">
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
                  background: 'rgba(148, 163, 184, 0.5)',
                }}
              />
              <span className="mt-1 text-[10px] text-slate-600">{n.toLocaleString()}</span>
            </div>
          ))}
        </div>
      </div>
      <div>
        <div className="font-semibold mb-1">Leading party</div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
          {partySwatches.map((p) => (
            <span key={p.code} className="flex items-center gap-2 text-[10px] text-slate-700">
              <span
                className="inline-block w-3 h-3 rounded-sm border border-slate-300"
                style={{ background: p.colour_hex ?? '#94a3b8' }}
              />
              <span>{p.code}</span>
            </span>
          ))}
          <span className="flex items-center gap-2 text-[10px] text-slate-600">
            <span
              className="inline-block w-3 h-3 rounded-sm border border-slate-300"
              style={{ background: NO_LEADER_FILL }}
            />
            <span>No result</span>
          </span>
        </div>
        <div className="mt-1 flex items-center gap-2 text-[10px] text-slate-600">
          <span className="inline-block w-3 h-3 rounded-sm border-2" style={{ borderColor: '#dc2626' }} />
          INEC conflict
          <span className="inline-block w-3 h-3 rounded-sm border-2 ml-2" style={{ borderColor: '#f97316' }} />
          Discrepancy
        </div>
      </div>
      {/*
        Ward geometry key — only meaningful at LGA focus, where the
        renderer mixes real GRID3 polygons (where reconciled) with
        centroid circles (fallback). Both glyphs carry the same
        meaning: the leading party of the ward they represent. The
        polygon is just spatially more precise; the dashed variant
        flags GRID3↔INEC fuzzy matches whose boundary may be off by
        a neighbouring ward.
      */}
      {level === 'lga' && (
        <div>
          <div className="font-semibold mb-1">Ward geometry</div>
          <div className="flex flex-col gap-1 text-[10px] text-slate-600">
            <span className="flex items-center gap-2">
              <span
                className="inline-block w-3 h-3 border border-slate-500"
                style={{ background: 'rgba(74, 222, 128, 0.6)' }}
              />
              GRID3 boundary
            </span>
            <span className="flex items-center gap-2">
              <span
                className="inline-block w-3 h-3 border border-slate-500"
                style={{
                  background: 'rgba(74, 222, 128, 0.42)',
                  borderStyle: 'dashed',
                }}
              />
              Approx. boundary (fuzzy match)
            </span>
            <span className="flex items-center gap-2">
              <span
                className="inline-block w-3 h-3 rounded-full border border-slate-500"
                style={{ background: 'rgba(74, 222, 128, 0.6)' }}
              />
              Centroid (no polygon yet)
            </span>
          </div>
        </div>
      )}
      {/* CC BY 4.0 attribution for the boundary dataset. */}
      <div className="text-[9px] text-slate-400 pt-1 border-t border-slate-100">
        Boundaries © GRID3 (CC BY 4.0)
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

// % verified rounded to whole %.
function pctVerified(a: RegionAggregate): number {
  if (a.pu_count <= 0) return 0;
  return Math.round(((a.units_consensus + a.units_inec_confirmed) / a.pu_count) * 100);
}

// Choropleth fill = the brand colour of the leading party in this
// region (state / LGA / ward). Regions whose leader hasn't been
// determined yet (no submissions, partial reporting under quorum) get
// the NO_LEADER neutral grey so the absence is honestly signalled
// instead of being hidden inside a "no data is data" green ramp.
// Verification quality (consensus, INEC conflict, discrepancy) moves
// to the stroke - see each call site below.
function regionFill(a: RegionAggregate, palette: PartyPalette): string {
  if (a.pu_count <= 0) return NO_LEADER_FILL;
  return partyColour(a.leader_party, palette);
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
  partyPalette,
  onFocus,
  onSelectRegion,
  onSelectPU,
}: {
  focus: MapFocus;
  aggregates: RegionAggregate[];
  units: PollingUnitDetail[];
  partyPalette: PartyPalette;
  onFocus: (f: MapFocus) => void;
  onSelectRegion: (r: RegionAggregate | null) => void;
  onSelectPU: (u: PollingUnitDetail) => void;
}) {
  const [geo, setGeo] = useState<GeoCollection | null>(null);
  const [lgaGeo, setLgaGeo] = useState<LgaCollection | null>(null);
  const [wardGeo, setWardGeo] = useState<WardCollection | null>(null);
  const [zoomScale, setZoomScale] = useState(1);
  const [panOffset, setPanOffset] = useState<[number, number]>([0, 0]);
  const svgRef = useRef<SVGSVGElement | null>(null);

  // Single TopoJSON file produced by scripts/build_nigeria_topojson.sh:
  // states are dissolved *from* the LGA layer, so the state border is
  // exactly the union of the LGA borders (no double-stroke, no gaps).
  // Shared LGA borders are encoded once as TopoJSON arcs.
  useEffect(() => {
    let cancelled = false;
    fetch('/nigeria.topo.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((topo: Topology | null) => {
        if (cancelled || !topo) return;
        // Convert each named object back into a GeoJSON FeatureCollection.
        // Casts: topojson-specification types are loose; we know the
        // properties shape because we control the build script.
        const statesObj = topo.objects.states as GeometryCollection<
          { state_code: string; state_name: string }
        > | undefined;
        const lgasObj = topo.objects.lgas as GeometryCollection<
          { name: string; state_code: string; state_name: string }
        > | undefined;
        if (statesObj) {
          const fc = topoFeature(topo, statesObj) as unknown as {
            features: Array<{
              properties: { state_code: string; state_name: string };
              geometry: Geom;
            }>;
          };
          // Adapt to the existing render code, which keys off
          // `properties.iso` (state_code prefixed with NG-) and
          // `properties.name`. Synthesised here so the rest of the
          // component doesn't change.
          setGeo({
            type: 'FeatureCollection',
            features: fc.features.map((f) => ({
              type: 'Feature',
              geometry: f.geometry,
              properties: {
                name: f.properties.state_name,
                kind: 'state',
                iso: `NG-${f.properties.state_code}`,
              },
            })),
          });
        }
        if (lgasObj) {
          const fc = topoFeature(topo, lgasObj) as unknown as {
            features: Array<{
              properties: { name: string; state_code: string; state_name: string };
              geometry: Geom;
            }>;
          };
          setLgaGeo({
            type: 'FeatureCollection',
            features: fc.features.map((f) => ({
              type: 'Feature',
              geometry: f.geometry,
              properties: {
                name: f.properties.name,
                kind: 'lga',
                state_code: f.properties.state_code,
                state_name: f.properties.state_name,
              },
            })),
          });
        }
      })
      .catch(() => {/* tolerate missing file */});
    return () => { cancelled = true; };
  }, []);

  // Ward polygons lazy-loaded when the user drills into an LGA. The API
  // returns a GeoJSON FeatureCollection of every ward in that LGA;
  // wards without a GRID3 polygon match come through with geometry=null
  // and the renderer falls back to a proportional-symbol circle for
  // them (see the ward render block below).
  useEffect(() => {
    if (focus.level !== 'lga') { setWardGeo(null); return; }
    const lgaCode = focus.lga_code;
    let cancelled = false;
    fetch(`/api/v1/lgas/${encodeURIComponent(lgaCode)}/wards`)
      .then((r) => (r.ok ? r.json() : null))
      .then((payload: { data?: WardCollection } | null) => {
        if (cancelled || !payload?.data) return;
        setWardGeo(payload.data);
      })
      .catch(() => {/* fall back to circle symbols */});
    return () => { cancelled = true; };
  }, [focus]);

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

  // Aggregate lookups so polygon click handlers can resolve the
  // matching region row (by INEC state code or by lowercase LGA name).
  const aggregatesByCode = useMemo(() => {
    const m = new Map<string, RegionAggregate>();
    for (const r of aggregates) m.set(r.code, r);
    return m;
  }, [aggregates]);
  const aggregatesByName = useMemo(() => {
    const m = new Map<string, RegionAggregate>();
    for (const r of aggregates) m.set(r.name.toLowerCase(), r);
    return m;
  }, [aggregates]);
  // Set of ward codes that have a GRID3 polygon loaded, so the
  // fallback symbol layer can skip them and avoid double-rendering.
  const wardsWithPolygons = useMemo(() => {
    const s = new Set<string>();
    if (!wardGeo) return s;
    for (const w of wardGeo.features) {
      if (w.geometry !== null) s.add(w.properties.ward_code);
    }
    return s;
  }, [wardGeo]);

  // viewBox = bbox of country / focused state / focused LGA / focused ward.
  // Prefer real polygon geometries when available (state polygon from
  // nigeria.topo.json, LGA polygon from same, ward polygons from
  // /api/v1/lgas/<code>/wards), falling back to aggregate centroids
  // and PU coordinates only when no polygon is loaded for the focus
  // level. This matters because the INEC roster carries no GPS for
  // polling units, so mv_ward_centroids can return (0,0)/NULL and the
  // centroid path produces a degenerate bbox that renders blank.
  const viewBox = useMemo<[number, number, number, number]>(() => {
    let bbox: [number, number, number, number] = [
      NIGERIA_BBOX.lngMin, NIGERIA_BBOX.latMin, NIGERIA_BBOX.lngMax, NIGERIA_BBOX.latMax,
    ];
    if (focus.level === 'state' || focus.level === 'lga' || focus.level === 'ward') {
      const s = states.find((f) => isoToStateCode(f.properties.iso) === focus.state_code);
      if (s) bbox = geomBbox(s.geometry);
    }
    if (focus.level === 'lga' || focus.level === 'ward') {
      // 1st choice: the LGA polygon itself (always present in
      // nigeria.topo.json — no dependency on submission data).
      const lgaCode = focus.level === 'lga' ? focus.lga_code : focus.lga_code;
      const lgaName = focus.level === 'lga' ? focus.lga_name : focus.lga_name;
      const lgaFeat = lgaGeo?.features.find(
        (l) => l.properties.state_code === focus.state_code && l.properties.name === lgaName,
      );
      if (lgaFeat) {
        bbox = geomBbox(lgaFeat.geometry);
      } else {
        // 2nd choice: union of ward polygon bboxes in this LGA.
        const wardsHere = wardGeo?.features.filter(
          (w) => w.geometry !== null && w.properties.lga_code === lgaCode,
        ) ?? [];
        if (wardsHere.length > 0) {
          let lngMin = Infinity, lngMax = -Infinity, latMin = Infinity, latMax = -Infinity;
          for (const w of wardsHere) {
            const [x1, y1, x2, y2] = geomBbox(w.geometry as Geom);
            if (x1 < lngMin) lngMin = x1;
            if (x2 > lngMax) lngMax = x2;
            if (y1 < latMin) latMin = y1;
            if (y2 > latMax) latMax = y2;
          }
          if (lngMin !== Infinity) bbox = [lngMin, latMin, lngMax, latMax];
        } else {
          // 3rd choice: aggregate centroids (works only when PUs
          // carry GPS — typically not true for the INEC roster).
          const pts = aggregates
            .map((a) => a.centroid)
            .filter((c) => c.lng !== 0 || c.lat !== 0);
          const inferred = pointsBbox(pts);
          if (inferred) bbox = inferred;
        }
      }
    }
    if (focus.level === 'ward') {
      // Drill further: prefer the focused ward's own polygon, fall
      // back to PU coordinates if it has neither polygon nor GPS.
      const wardFeat = wardGeo?.features.find(
        (w) => w.geometry !== null && w.properties.ward_code === focus.ward_code,
      );
      if (wardFeat) {
        bbox = geomBbox(wardFeat.geometry as Geom);
      } else {
        const pts = units.map((u) => u.coordinates).filter((c) => c.lng !== 0 || c.lat !== 0);
        const inferred = pointsBbox(pts);
        if (inferred) bbox = inferred;
      }
    }
    const [vx, vy, vw, vh] = bboxToViewBox(bbox);
    const cx = vx + vw / 2, cy = vy + vh / 2;
    const w = vw / zoomScale, h = vh / zoomScale;
    return [cx - w / 2 + panOffset[0], cy - h / 2 + panOffset[1], w, h];
  }, [focus, states, aggregates, units, lgaGeo, wardGeo, zoomScale, panOffset]);

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
    <div className="relative w-full h-full">
      <ZoomControls
        onZoomIn={() => setZoomScale((z) => Math.min(40, z * 1.4))}
        onZoomOut={() => setZoomScale((z) => Math.max(1, z / 1.4))}
        onReset={() => { setZoomScale(1); setPanOffset([0, 0]); }}
      />
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
      {country && (
        <path
          d={featureToPath(country)}
          fill="url(#ng-land)"
          stroke="none"
          filter="url(#ng-shadow)"
        />
      )}

      {/*
        State polygons. At country focus the fill is the % verified
        green ramp (replacing the old "transparent + giant circle"
        rendering). When the user has drilled into a state, the other
        states fade to a light tint for geographic context while the
        focused state's polygon is left empty so its LGAs show through.
      */}
      {states.map((s) => {
        const code = isoToStateCode(s.properties.iso);
        const agg = code ? aggregatesByCode.get(code) : undefined;
        const isFocused = focus.level !== 'country' && focus.state_code === code;
        const isOtherFocused = focus.level !== 'country' && !isFocused;
        const clickable = focus.level === 'country';
        const fill = !clickable && !isFocused
          ? '#f1f5f9'
          : agg ? regionFill(agg, partyPalette) : '#e2e8f0';
        // Stroke surfaces verification quality once the fill is owned
        // by the leading-party colour: red for INEC conflicts, orange
        // for discrepancies, blue for the focused state, slate otherwise.
        const stroke = isFocused
          ? '#1d4ed8'
          : agg && agg.units_inec_conflict > 0
            ? '#dc2626'
            : agg && agg.units_discrepancy > 0
              ? '#f97316'
              : '#94a3b8';
        return (
          <path
            key={s.properties.iso ?? s.properties.name}
            d={featureToPath(s)}
            fill={isFocused ? 'transparent' : fill}
            fillOpacity={isOtherFocused ? 0.55 : 1}
            stroke={stroke}
            strokeWidth={isFocused ? 1.6 : (stroke !== '#94a3b8' ? 1.0 : 0.6)}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
            style={{ cursor: clickable ? 'pointer' : 'default' }}
            onClick={
              clickable
                ? guarded(() => {
                    if (!code) return;
                    onSelectRegion(agg ?? null);
                    onFocus({ level: 'state', state_code: code, state_name: s.properties.name });
                  })
                : undefined
            }
          >
            <title>
              {s.properties.name}
              {agg ? ` — ${pctVerified(agg)}% verified, ${agg.pu_count.toLocaleString()} PUs` : ''}
            </title>
          </path>
        );
      })}

      {/*
        LGA polygons at state focus. Lazy-loaded from /nigeria-lgas.geo.json
        (same dataset /en/results uses). Filled by % verified, with a
        red/orange outline on conflict regions to flag problems. At LGA
        focus we keep them drawn but dim the non-focused ones so the
        focused LGA stands out.
      */}
      {(focus.level === 'state' || focus.level === 'lga') && lgaGeo &&
        lgaGeo.features
          .filter((f) => f.properties.state_code === focus.state_code)
          .map((l) => {
            // At state focus the aggregates are LGA-level so a name
            // match colours the polygon by % verified. At LGA focus
            // the aggregates are wards, so we just dim non-focused
            // LGAs and leave the focused one highlighted.
            const agg = focus.level === 'state'
              ? aggregatesByName.get(l.properties.name.toLowerCase())
              : undefined;
            const isFocused = focus.level === 'lga' && l.properties.name === focus.lga_name;
            const isOtherFocused = focus.level === 'lga' && !isFocused;
            const fill = agg ? regionFill(agg, partyPalette) : '#f1f5f9';
            const stroke = agg && agg.units_inec_conflict > 0
              ? '#dc2626'
              : agg && agg.units_discrepancy > 0
                ? '#f97316'
                : isFocused ? '#0f172a' : '#94a3b8';
            return (
              <path
                key={l.properties.name}
                d={featureToPath(l as unknown as GeoFeature)}
                fill={fill}
                fillOpacity={isOtherFocused ? 0.4 : 1}
                stroke={stroke}
                strokeWidth={isFocused ? 1.5 : 0.5}
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
                style={{ cursor: focus.level === 'state' ? 'pointer' : 'default' }}
                onClick={
                  focus.level === 'state'
                    ? guarded(() => {
                        if (!agg) return;
                        onSelectRegion(agg);
                        onFocus(descend(focus, {
                          code: agg.code, name: agg.name, state_code: agg.state_code,
                        }));
                      })
                    : undefined
                }
              >
                <title>
                  {l.properties.name}
                  {agg ? ` — ${pctVerified(agg)}% verified, ${agg.pu_count.toLocaleString()} PUs` : ' — no data'}
                </title>
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
        Ward layer at LGA focus.

        Wards with a GRID3 polygon (from ward_boundaries, fetched via
        /api/v1/lgas/{code}/wards) render as filled polygons coloured by
        % verified — same visual language as states/LGAs. Wards still
        awaiting reconciliation (geometry: null) fall back to the
        proportional-symbol circle so nothing disappears from the map.
        Clicking either form descends into ward focus, which shows the
        polling units in that ward as dots.
      */}
      {focus.level === 'lga' && wardGeo && wardGeo.features
        .filter((w) => w.geometry !== null && w.properties.lga_code === focus.lga_code)
        .map((w) => {
          const agg = aggregatesByCode.get(w.properties.ward_code);
          const fill = agg ? regionFill(agg, partyPalette) : '#f1f5f9';
          const stroke = agg && agg.units_inec_conflict > 0
            ? '#dc2626'
            : agg && agg.units_discrepancy > 0
              ? '#f97316'
              : '#94a3b8';
          // Dashed stroke for low-confidence reconciliations (GRID3 ↔
          // INEC fuzzy match below 0.95). The polygon may be slightly
          // off the actual INEC ward boundary, so signal that
          // visually rather than implying boundary precision we don't
          // have. Confidence 1.0 = exact name match; ~0.83 = LGA
          // fuzzy + exact ward; lower = ward fuzzy.
          const conf = w.properties.match_confidence;
          const isLowConf = conf !== null && conf < 0.95;
          return (
            <path
              key={w.properties.ward_code}
              d={featureToPath(w as unknown as GeoFeature)}
              fill={fill}
              fillOpacity={isLowConf ? 0.7 : 1}
              stroke={stroke}
              strokeWidth={0.6}
              strokeDasharray={isLowConf ? '2 2' : undefined}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              style={{ cursor: 'pointer' }}
              onClick={guarded(() => {
                if (!agg) return;
                onSelectRegion(agg);
                onFocus(descend(focus, {
                  code: agg.code, name: agg.name, state_code: agg.state_code,
                }));
              })}
            >
              <title>
                {w.properties.name}
                {agg ? ` — ${pctVerified(agg)}% verified, ${agg.pu_count.toLocaleString()} PUs` : ' — no data'}
                {isLowConf ? ` · approx. boundary (GRID3 match ${(conf! * 100).toFixed(0)}%)` : ''}
              </title>
            </path>
          );
        })}

      {/*
        Fallback proportional-symbol circles at LGA focus for any ward
        whose GRID3 polygon hasn't been reconciled yet (or for the brief
        window before wardGeo finishes loading). Wards that DO have a
        polygon are filtered out so we don't double-render.
      */}
      {focus.level === 'lga' && (
        <AggregateSymbols
          regions={aggregates.filter((r) => !wardsWithPolygons.has(r.code))}
          project={(lng, lat) => ({ x: toX(lng), y: toY(lat) })}
          pxPerUnit={pxPerUnit}
          onSelect={guarded((r) => {
            onSelectRegion(r);
            onFocus(descend(focus, { code: r.code, name: r.name, state_code: r.state_code }));
          })}
        />
      )}

      {focus.level === 'ward' && units.map((u) => {
        // PU dot fill = leading party at this polling unit, derived
        // from consensus_data.candidate_votes (highest vote count
        // wins). Falls back to NO_LEADER_FILL when the PU has no
        // submissions yet or the consensus extractor hasn't produced
        // candidate_votes. Verification status (consensus, INEC
        // conflict, etc.) moves to the stroke so it remains visible
        // without competing with the political signal.
        const leader = leaderFromCandidateVotes(u.consensus_data?.candidate_votes);
        const fillColour = leader ? partyColour(leader, partyPalette) : NO_LEADER_FILL;
        const strokeColour =
          u.status === 'inec_conflict' ? '#dc2626'
          : u.status === 'discrepancy' ? '#f97316'
          : '#0f172a';
        return (
          <circle
            key={u.pu_code}
            cx={toX(u.coordinates.lng)}
            cy={toY(u.coordinates.lat)}
            r={4 / Math.max(pxPerUnit / 10, 1)}
            fill={fillColour}
            stroke={strokeColour}
            strokeOpacity={strokeColour === '#0f172a' ? 0.3 : 0.9}
            strokeWidth={strokeColour === '#0f172a' ? 0.5 : 1}
            vectorEffect="non-scaling-stroke"
            style={{ cursor: 'pointer' }}
            onClick={guarded(() => onSelectPU(u))}
          >
            <title>
              {u.pu_name}
              {leader ? ` — leading: ${leader}` : ' — no result yet'}
              {' · '}{STATUS_LABEL[u.status]}
            </title>
          </circle>
        );
      })}
    </svg>
    </div>
  );
}

function ZoomControls({
  onZoomIn,
  onZoomOut,
  onReset,
}: {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
}) {
  return (
    <div className="absolute top-3 left-3 z-10 flex flex-col bg-white rounded-md shadow border border-slate-200 overflow-hidden">
      <button
        type="button"
        onClick={onZoomIn}
        className="w-8 h-8 flex items-center justify-center hover:bg-slate-100 text-slate-700 text-lg leading-none border-b border-slate-200"
        aria-label="Zoom in"
        title="Zoom in"
      >
        +
      </button>
      <button
        type="button"
        onClick={onZoomOut}
        className="w-8 h-8 flex items-center justify-center hover:bg-slate-100 text-slate-700 text-lg leading-none border-b border-slate-200"
        aria-label="Zoom out"
        title="Zoom out"
      >
        −
      </button>
      <button
        type="button"
        onClick={onReset}
        className="w-8 h-8 flex items-center justify-center hover:bg-slate-100 text-slate-600 text-sm leading-none"
        aria-label="Reset view"
        title="Reset view"
      >
        ⟲
      </button>
    </div>
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
