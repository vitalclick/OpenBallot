'use client';

import { useMemo } from 'react';

import type { RegionAggregate } from '@/lib/types';

// Proportional symbol renderer for the SVG fallback map.
//
// One circle per region; radius scales with sqrt(pu_count) so visual
// area is proportional to PU count (the perceptual default for
// proportional-symbol maps). Fill colour is a green->grey ramp on
// % consensus, so a state with 100% verified PUs is solid green and
// one with 0 verification is grey. Border colour flips to red/orange
// if there are any conflict / discrepancy PUs - the most important
// thing for an election-observer audience is "where is something
// going wrong", not "what's the average".

interface Props {
  regions: RegionAggregate[];
  // Convert lng/lat into the SVG coordinate space the parent uses.
  project: (lng: number, lat: number) => { x: number; y: number };
  // Pixel scale of the current viewBox so we can keep symbol sizes
  // roughly constant as the user zooms in.
  pxPerUnit: number;
  onSelect: (region: RegionAggregate) => void;
  // Returns true when this circle should pulse - used to highlight
  // hover/keyboard-focused regions.
  highlighted?: (code: string) => boolean;
}

export function AggregateSymbols({
  regions,
  project,
  pxPerUnit,
  onSelect,
  highlighted,
}: Props) {
  const scale = useMemo(() => buildRadiusScale(regions), [regions]);

  return (
    <g className="aggregate-symbols">
      {regions.map((r) => {
        const { x, y } = project(r.centroid.lng, r.centroid.lat);
        const rPx = scale(r.pu_count);
        // Convert from pixels back to viewBox units so the radius looks
        // right after `preserveAspectRatio` scaling.
        const rUnits = rPx / Math.max(pxPerUnit, 0.0001);
        const fill = fillForRegion(r);
        const stroke = strokeForRegion(r);
        const isHi = highlighted?.(r.code);
        return (
          <g key={r.code} className="aggregate-symbol" style={{ cursor: 'pointer' }}>
            <circle
              cx={x}
              cy={y}
              r={rUnits}
              fill={fill}
              fillOpacity={0.78}
              stroke={stroke}
              strokeWidth={isHi ? 1.6 : 0.9}
              strokeOpacity={0.85}
              vectorEffect="non-scaling-stroke"
              onClick={() => onSelect(r)}
            >
              <title>{tooltipFor(r)}</title>
            </circle>
          </g>
        );
      })}
    </g>
  );
}

// Square-root scaling so visual area encodes pu_count. Min/max pixel
// radii are chosen so even the smallest ward is hittable, and the
// largest state symbol doesn't swallow its neighbours.
function buildRadiusScale(regions: RegionAggregate[]): (n: number) => number {
  const counts = regions.map((r) => Math.max(0, r.pu_count));
  const max = counts.length ? Math.max(...counts) : 1;
  // Smaller dynamic range for ward-level renders so a 5-PU ward and a
  // 282-PU ward are still distinguishable without one disappearing.
  const looksLikeWardLevel = regions.length > 0 && regions.every((r) => r.level === 'ward');
  const rMin = 5;
  const rMax = looksLikeWardLevel ? 18 : 28;
  return (n: number) => {
    if (max <= 0) return rMin;
    const t = Math.sqrt(Math.max(n, 0)) / Math.sqrt(max);
    return rMin + t * (rMax - rMin);
  };
}

// % consensus -> green ramp. Reporting-but-not-yet-verified is amber.
// No data is light grey.
function fillForRegion(r: RegionAggregate): string {
  if (r.pu_count === 0) return '#e2e8f0';
  const verified = r.units_consensus + r.units_inec_confirmed;
  const pctVerified = verified / r.pu_count;
  if (pctVerified >= 0.85) return '#16a34a';   // strong green
  if (pctVerified >= 0.50) return '#4ade80';   // light green
  if (pctVerified >= 0.20) return '#a3e635';   // lime
  if (r.units_reporting / r.pu_count >= 0.50) return '#facc15'; // amber - reporting
  if (r.units_reporting > 0) return '#fde68a';                  // pale amber
  return '#e2e8f0';
}

// Border flips to red/orange when there's any conflict so the eye is
// drawn to problem regions even before reading the legend.
function strokeForRegion(r: RegionAggregate): string {
  if (r.units_inec_conflict > 0) return '#dc2626';
  if (r.units_discrepancy > 0)   return '#f97316';
  return '#0f172a';
}

function tooltipFor(r: RegionAggregate): string {
  const verified = r.units_consensus + r.units_inec_confirmed;
  const pct = r.pu_count ? Math.round((verified / r.pu_count) * 100) : 0;
  const parts = [
    `${r.name}`,
    `${r.pu_count.toLocaleString()} polling units`,
    `${pct}% verified`,
  ];
  if (r.units_inec_conflict > 0) parts.push(`${r.units_inec_conflict} INEC conflict`);
  if (r.units_discrepancy > 0)   parts.push(`${r.units_discrepancy} discrepancy`);
  if (r.leader_party && r.leader_share !== null) {
    parts.push(`Lead: ${r.leader_party} ${Math.round(r.leader_share * 100)}%`);
  }
  return parts.join(' • ');
}
