'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { DashboardPartyResult } from '@/lib/types';

// Interactive Nigeria choropleth with three drill-down levels:
//   country  -> all 37 states coloured by leading party
//   state    -> all LGAs in the focused state coloured by leading party
//   lga      -> the focused LGA highlighted (terminal level - ward and
//               polling-unit boundaries are not yet integrated)
//
// Click a feature to drill down one level; use the breadcrumb at the
// bottom or the zoom-out button to go back up. Hover for a tooltip.
// Mouse-wheel zoom + drag-to-pan are wired on top of the SVG viewBox.

const NAME_TO_CODE: Record<string, string> = {
  Lagos: 'LA', Kano: 'KN', Rivers: 'RI', 'Federal Capital Territory': 'FC',
  // Other states match Natural Earth name but we only have mock results for 4.
};

const W = 1000, H = 700;
const NIGERIA_BBOX = { lngMin: 2.5, lngMax: 14.7, latMin: 4.0, latMax: 14.0 };

type Geom =
  | { type: 'Polygon'; coordinates: number[][][] }
  | { type: 'MultiPolygon'; coordinates: number[][][][] };

type StateFeature = {
  type: 'Feature';
  properties: { name: string; kind: 'country' | 'state'; iso?: string };
  geometry: Geom;
};
type StateCollection = { type: 'FeatureCollection'; features: StateFeature[] };

type LgaFeature = {
  type: 'Feature';
  properties: { name: string; kind: 'lga'; state_code: string | null; state_name: string };
  geometry: Geom;
};
type LgaCollection = { type: 'FeatureCollection'; features: LgaFeature[] };

export interface ChoroplethFocus {
  level: 'country' | 'state' | 'lga';
  stateCode?: string;
  stateName?: string;
  lgaName?: string;
}

interface Props {
  winners: Record<string, string>;
  partyByCode: Record<string, DashboardPartyResult>;
  /** Fired whenever the user drills in or back out. */
  onFocusChange?: (focus: ChoroplethFocus) => void;
}

type Level = 'country' | 'state' | 'lga';

interface Focus {
  level: Level;
  stateCode?: string;   // when level === 'state' or 'lga'
  stateName?: string;
  lgaName?: string;     // when level === 'lga'
}

export function ChoroplethMap({ winners, partyByCode, onFocusChange }: Props) {
  const [geo, setGeo] = useState<StateCollection | null>(null);
  const [lgas, setLgas] = useState<LgaCollection | null>(null);
  const [lgaError, setLgaError] = useState<string | null>(null);
  const [focus, setFocus] = useState<Focus>({ level: 'country' });

  // Notify the parent dashboard whenever the user drills in / out so it
  // can rescope the title, the seat total, and the party totals table.
  useEffect(() => {
    onFocusChange?.({
      level: focus.level,
      stateCode: focus.stateCode,
      stateName: focus.stateName,
      lgaName: focus.lgaName,
    });
  }, [focus, onFocusChange]);
  const [hover, setHover] = useState<{ x: number; y: number; label: string } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  // Country + state outlines (always loaded).
  useEffect(() => {
    let cancelled = false;
    fetch('/nigeria.geo.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!cancelled && j) setGeo(j as StateCollection); });
    return () => { cancelled = true; };
  }, []);

  // LGAs - lazy-loaded on first state drill-down.
  useEffect(() => {
    if (focus.level === 'country' || lgas || lgaError) return;
    let cancelled = false;
    fetch('/nigeria-lgas.geo.json')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('failed'))))
      .then((j) => { if (!cancelled) setLgas(j as LgaCollection); })
      .catch(() => { if (!cancelled) setLgaError('Failed to load LGA boundaries.'); });
    return () => { cancelled = true; };
  }, [focus.level, lgas, lgaError]);

  const stateFeatures = useMemo(
    () => geo?.features.filter((f) => f.properties.kind === 'state') ?? [],
    [geo]
  );
  const country = useMemo(
    () => geo?.features.find((f) => f.properties.kind === 'country') ?? null,
    [geo]
  );

  // Resolve the currently-displayed bounding box. Drives the SVG viewBox.
  const focusBbox = useMemo(() => {
    if (focus.level === 'country') {
      return [NIGERIA_BBOX.lngMin, NIGERIA_BBOX.latMin, NIGERIA_BBOX.lngMax, NIGERIA_BBOX.latMax];
    }
    if (focus.level === 'state' && focus.stateName) {
      const s = stateFeatures.find((f) => f.properties.name === focus.stateName);
      return s ? geomBbox(s.geometry) : null;
    }
    if (focus.level === 'lga' && focus.lgaName && lgas) {
      const l = lgas.features.find((f) => f.properties.name === focus.lgaName);
      return l ? geomBbox(l.geometry) : null;
    }
    return null;
  }, [focus, stateFeatures, lgas]);

  // viewBox derived from focusBbox + a manual zoom/pan offset.
  const [zoomScale, setZoomScale] = useState(1);
  const [panOffset, setPanOffset] = useState<[number, number]>([0, 0]);
  useEffect(() => { setZoomScale(1); setPanOffset([0, 0]); }, [focus]);

  const viewBox = useMemo(() => {
    const bbox = focusBbox ?? [
      NIGERIA_BBOX.lngMin, NIGERIA_BBOX.latMin, NIGERIA_BBOX.lngMax, NIGERIA_BBOX.latMax,
    ];
    const [vx, vy, vw, vh] = bboxToViewBox(bbox);
    const cx = vx + vw / 2, cy = vy + vh / 2;
    const w = vw / zoomScale, h = vh / zoomScale;
    return [cx - w / 2 + panOffset[0], cy - h / 2 + panOffset[1], w, h] as const;
  }, [focusBbox, zoomScale, panOffset]);

  // SVG path helpers.
  const ringToPath = useCallback((ring: number[][]) =>
    ring.map(([lng, lat], i) =>
      `${i === 0 ? 'M' : 'L'}${toX(lng).toFixed(1)} ${toY(lat).toFixed(1)}`
    ).join(' ') + ' Z', []);
  const featureToPath = useCallback((f: { geometry: Geom }) => {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    return polys.map((p) => p.map(ringToPath).join(' ')).join(' ');
  }, [ringToPath]);

  // Per-LGA winner using a deterministic hash, biased toward the state's
  // overall winner so the LGA view roughly matches the country choropleth.
  const lgaWinner = useCallback(
    (lgaName: string, stateCode: string | null): string | null => {
      if (!stateCode) return null;
      const stateWinner = winners[stateCode];
      const h = hash(`${stateCode}-${lgaName}`);
      // 65% of LGAs follow the state's leader; 35% defect to a random party
      // from the top 4 by total votes (drives visual variety).
      if (!stateWinner) return null;
      if (h % 100 < 65) return stateWinner;
      const top = Object.values(partyByCode)
        .sort((a, b) => b.total_votes - a.total_votes)
        .slice(0, 4)
        .map((p) => p.code);
      return top[h % top.length];
    },
    [winners, partyByCode]
  );

  const fillFor = useCallback(
    (winner: string | null): string => {
      if (!winner) return '#e2e8f0';
      return partyByCode[winner]?.color ?? '#94a3b8';
    },
    [partyByCode]
  );

  // Mouse handlers.
  const onMouseMove = useCallback((e: React.MouseEvent<SVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    setHover((h) => h ? { ...h, x: e.clientX - rect.left, y: e.clientY - rect.top } : h);
  }, []);

  const onWheel = useCallback((e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    setZoomScale((z) => Math.min(20, Math.max(1, z * factor)));
  }, []);

  // Drag-to-pan. We deliberately delay setPointerCapture until the user
  // has actually moved past DRAG_THRESHOLD pixels. Capturing on
  // pointerdown reroutes the subsequent click event away from the path
  // the user clicked on, which broke the drill-down click handlers.
  const DRAG_THRESHOLD = 5;
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{
    startX: number; startY: number; px: number; py: number;
    moved: boolean; pointerId: number;
  } | null>(null);
  const didDragRef = useRef(false);
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
    const [, , vw] = viewBox;
    const scale = vw / rect.width;
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
  const guardedClick = useCallback(<T,>(fn: (arg: T) => void) =>
    (arg: T) => { if (!didDragRef.current) fn(arg); }, []);

  // Drill-down handlers.
  const drillToState = (f: StateFeature) =>
    setFocus({
      level: 'state',
      stateName: f.properties.name,
      stateCode: NAME_TO_CODE[f.properties.name],
    });
  const drillToLga = (f: LgaFeature) =>
    setFocus((prev) => ({
      level: 'lga',
      stateName: prev.stateName ?? f.properties.state_name,
      stateCode: prev.stateCode ?? (f.properties.state_code ?? undefined),
      lgaName: f.properties.name,
    }));

  // Filtered features for the current level.
  const visibleLgas = useMemo(() => {
    if (focus.level === 'country' || !lgas) return [];
    return lgas.features.filter((f) => f.properties.state_name === focus.stateName);
  }, [focus, lgas]);

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={viewBox.join(' ')}
        className="w-full h-auto select-none touch-none"
        preserveAspectRatio="xMidYMid meet"
        onMouseMove={onMouseMove}
        onMouseLeave={() => setHover(null)}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{ cursor: dragging ? 'grabbing' : 'grab', background: '#f1f5f9' }}
      >
        {/* Country backdrop (always visible) */}
        {country && (
          <path
            d={featureToPath(country)}
            fill="#ffffff"
            stroke="#cbd5e1"
            strokeWidth={0.4}
            vectorEffect="non-scaling-stroke"
          />
        )}

        {/* Country level: all states */}
        {focus.level === 'country' && stateFeatures.map((s) => {
          const code = NAME_TO_CODE[s.properties.name];
          const winner = code ? winners[code] : null;
          return (
            <path
              key={s.properties.name}
              d={featureToPath(s)}
              fill={fillFor(winner)}
              stroke="#94a3b8"
              strokeWidth={0.6}
              vectorEffect="non-scaling-stroke"
              style={{ cursor: 'pointer' }}
              onMouseEnter={() =>
                setHover({ x: 0, y: 0, label: `${s.properties.name}${winner ? ` – ${winner} leading` : ''}` })
              }
              onClick={guardedClick(() => drillToState(s))}
            />
          );
        })}

        {/* State level: all LGAs in the focused state */}
        {focus.level !== 'country' && visibleLgas.map((l) => {
          const winner = lgaWinner(l.properties.name, l.properties.state_code);
          const isFocused = focus.level === 'lga' && l.properties.name === focus.lgaName;
          return (
            <path
              key={l.properties.name}
              d={featureToPath(l)}
              fill={fillFor(winner)}
              fillOpacity={focus.level === 'lga' && !isFocused ? 0.35 : 1}
              stroke={isFocused ? '#0f172a' : '#94a3b8'}
              strokeWidth={isFocused ? 1.5 : 0.5}
              vectorEffect="non-scaling-stroke"
              style={{ cursor: focus.level === 'state' ? 'pointer' : 'default' }}
              onMouseEnter={() =>
                setHover({
                  x: 0, y: 0,
                  label: `${l.properties.name}${winner ? ` – ${winner} leading` : ''}`,
                })
              }
              onClick={guardedClick(() => focus.level === 'state' && drillToLga(l))}
            />
          );
        })}

        {/* State outlines on top (light) when at country level for separation */}
        {focus.level === 'country' && stateFeatures.map((s) => (
          <path
            key={`outline-${s.properties.name}`}
            d={featureToPath(s)}
            fill="none"
            stroke="#475569"
            strokeWidth={0.4}
            vectorEffect="non-scaling-stroke"
            pointerEvents="none"
          />
        ))}

        {/* Country border, always on top */}
        {country && (
          <path
            d={featureToPath(country)}
            fill="none"
            stroke="#1f2937"
            strokeWidth={1.2}
            vectorEffect="non-scaling-stroke"
            pointerEvents="none"
          />
        )}
      </svg>

      {/* Zoom controls */}
      <div className="absolute bottom-2 right-2 flex flex-col bg-white rounded shadow text-sm overflow-hidden">
        <button
          aria-label="Zoom in"
          className="w-7 h-7 hover:bg-slate-100 border-b"
          onClick={() => setZoomScale((z) => Math.min(20, z * 1.4))}
        >+</button>
        <button
          aria-label="Zoom out"
          className="w-7 h-7 hover:bg-slate-100"
          onClick={() => setZoomScale((z) => Math.max(1, z / 1.4))}
        >−</button>
      </div>

      {/* Tooltip */}
      {hover?.label && (
        <div
          className="absolute pointer-events-none bg-white border rounded px-2 py-1 text-xs shadow"
          style={{ left: hover.x + 12, top: hover.y + 12 }}
        >
          {hover.label}
        </div>
      )}

      {/* Breadcrumb */}
      <div className="flex items-center gap-2 mt-2 text-sm">
        <button
          className="text-ng-700 hover:underline"
          onClick={() => setFocus({ level: 'country' })}
        >
          Nigeria
        </button>
        {focus.stateName && (
          <>
            <span className="text-slate-400">|</span>
            <button
              className="text-ng-700 hover:underline"
              onClick={() =>
                setFocus({
                  level: 'state',
                  stateName: focus.stateName,
                  stateCode: focus.stateCode,
                })
              }
            >
              {focus.stateName}
            </button>
          </>
        )}
        {focus.lgaName && (
          <>
            <span className="text-slate-400">|</span>
            <span className="text-slate-700 font-medium">{focus.lgaName}</span>
          </>
        )}
        {focus.level === 'lga' && (
          <span className="ml-auto text-xs text-slate-500">
            Ward / polling unit boundaries not yet integrated
          </span>
        )}
      </div>

      {lgaError && focus.level !== 'country' && (
        <div className="mt-2 text-xs text-red-600">{lgaError}</div>
      )}
    </div>
  );
}

// --- helpers ---------------------------------------------------------

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

// Pad the bbox a little and convert to SVG viewBox coordinates.
function bboxToViewBox([lngMin, latMin, lngMax, latMax]: number[]): [number, number, number, number] {
  const x1 = toX(lngMin), x2 = toX(lngMax);
  const y1 = toY(latMax), y2 = toY(latMin);
  const w = x2 - x1, h = y2 - y1;
  const pad = Math.max(w, h) * 0.08;
  return [x1 - pad, y1 - pad, w + pad * 2, h + pad * 2];
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}
