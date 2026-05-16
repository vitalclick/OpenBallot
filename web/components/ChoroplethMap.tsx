'use client';

import { useEffect, useState } from 'react';

import type { DashboardPartyResult } from '@/lib/types';

// State-level choropleth. Each state is filled with its winning party's
// colour. Data source is the same nigeria.geo.json file used by the
// no-Mapbox results map fallback.

const NIGERIA_BBOX = { lngMin: 2.5, lngMax: 14.7, latMin: 4.0, latMax: 14.0 };
const W = 1000, H = 700;

type GeoFeature = {
  type: 'Feature';
  properties: { name: string; kind: 'country' | 'state'; iso?: string };
  geometry:
    | { type: 'Polygon'; coordinates: number[][][] }
    | { type: 'MultiPolygon'; coordinates: number[][][][] };
};

type GeoCollection = { type: 'FeatureCollection'; features: GeoFeature[] };

// Map Natural Earth state names to the codes used by mock data. Only
// the four states with mock PUs are coloured; the rest stay neutral.
const NAME_TO_CODE: Record<string, string> = {
  Lagos: 'LA',
  Kano: 'KN',
  Rivers: 'RI',
  'Federal Capital Territory': 'FC',
};

interface Props {
  winners: Record<string, string>;
  partyByCode: Record<string, DashboardPartyResult>;
}

export function ChoroplethMap({ winners, partyByCode }: Props) {
  const [geo, setGeo] = useState<GeoCollection | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/nigeria.geo.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!cancelled && j) setGeo(j as GeoCollection); })
      .catch(() => {/* leave blank */});
    return () => { cancelled = true; };
  }, []);

  const toX = (lng: number) =>
    ((lng - NIGERIA_BBOX.lngMin) / (NIGERIA_BBOX.lngMax - NIGERIA_BBOX.lngMin)) * W;
  const toY = (lat: number) =>
    H - ((lat - NIGERIA_BBOX.latMin) / (NIGERIA_BBOX.latMax - NIGERIA_BBOX.latMin)) * H;

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

  const fillFor = (stateName: string): { fill: string; title: string } => {
    const code = NAME_TO_CODE[stateName];
    const winner = code ? winners[code] : undefined;
    if (winner) {
      const party = partyByCode[winner];
      return {
        fill: party?.color ?? '#e2e8f0',
        title: `${stateName} – ${winner} leading`,
      };
    }
    return { fill: '#e2e8f0', title: `${stateName} – no data` };
  };

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" preserveAspectRatio="xMidYMid meet">
      <rect x={0} y={0} width={W} height={H} fill="#f1f5f9" />
      {country && (
        <path d={featureToPath(country)} fill="#ffffff" stroke="none" />
      )}
      {states.map((s) => {
        const { fill, title } = fillFor(s.properties.name);
        return (
          <path
            key={s.properties.iso ?? s.properties.name}
            d={featureToPath(s)}
            fill={fill}
            stroke="#94a3b8"
            strokeWidth={0.5}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          >
            <title>{title}</title>
          </path>
        );
      })}
      {country && (
        <path
          d={featureToPath(country)}
          fill="none"
          stroke="#475569"
          strokeWidth={1.2}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}
