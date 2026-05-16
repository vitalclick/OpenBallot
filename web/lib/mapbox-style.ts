// Mapbox GL JS layer + source configuration for the OpenBallot results map.
//
// One vector source - our /api/v1/tiles endpoint. The server picks the
// right layer per zoom band (states / lgas / wards / polling_units), so
// we declare one source-layer per band.
//
// IMPORTANT: layer visibility is also driven by the *focus* state
// (lib/map-focus.ts), not just by zoom. MapboxRenderer toggles
// visibility/filter when the user drills in or out, so the dot layers
// never expose 13k+ polling units at country zoom.
//
// Colours are driven by `status_int` (encoded in migration 0006):
//   0 no_data, 1 single_source, 2 inec_published, 3 consensus,
//   4 discrepancy, 5 inec_confirmed, 6 inec_conflict

export const STATUS_INT_TO_COLOUR: Record<number, string> = {
  0: '#e5e7eb',
  1: '#f6c453',
  2: '#64748b',
  3: '#22c55e',
  4: '#f97316',
  5: '#2563eb',
  6: '#dc2626',
};

const colourByStatus: any[] = [
  'match',
  ['get', 'status_int'],
  0, STATUS_INT_TO_COLOUR[0],
  1, STATUS_INT_TO_COLOUR[1],
  2, STATUS_INT_TO_COLOUR[2],
  3, STATUS_INT_TO_COLOUR[3],
  4, STATUS_INT_TO_COLOUR[4],
  5, STATUS_INT_TO_COLOUR[5],
  6, STATUS_INT_TO_COLOUR[6],
  STATUS_INT_TO_COLOUR[0],
];

// % consensus -> green ramp. Reusable across the state choropleth and
// the LGA / ward proportional symbols. Falls back to grey when there
// are no PUs reporting yet.
function verifiedRamp(): any[] {
  const pct = ['/',
    ['to-number', ['coalesce', ['get', 'units_consensus'], 0]],
    ['max', ['to-number', ['coalesce', ['get', 'pu_count'], 1]], 1],
  ];
  const reporting = ['/',
    ['to-number', ['coalesce', ['get', 'units_reporting'], 0]],
    ['max', ['to-number', ['coalesce', ['get', 'pu_count'], 1]], 1],
  ];
  return [
    'case',
    ['>=', pct, 0.85],       '#16a34a',
    ['>=', pct, 0.50],       '#4ade80',
    ['>=', pct, 0.20],       '#a3e635',
    ['>=', reporting, 0.50], '#facc15',
    ['>', ['get', 'units_reporting'], 0], '#fde68a',
    '#e2e8f0',
  ];
}

// Border colour highlights conflict / discrepancy regions so the eye
// is drawn to problem areas regardless of zoom level.
function conflictStroke(): any[] {
  return [
    'case',
    ['>', ['get', 'units_inec_conflict'], 0], '#dc2626',
    ['>', ['get', 'units_discrepancy'], 0],   '#f97316',
    '#0f172a',
  ];
}

// Sqrt scale for proportional symbols so area encodes pu_count. Input
// is sqrt(pu_count): sqrt(5)≈2 (smallest ward), sqrt(282)≈17 (largest
// ward), sqrt(13325)≈115 (largest state). Output is in pixels.
const radiusByPuCount = (rMin: number, rMid: number, rMax: number): any[] => [
  'interpolate', ['linear'],
  ['sqrt', ['coalesce', ['to-number', ['get', 'pu_count']], 1]],
  1,   rMin,
  17,  rMid,
  115, rMax,
];

export function buildSources(electionId: string, tileBaseUrl: string) {
  return {
    openballot: {
      type: 'vector' as const,
      tiles: [`${tileBaseUrl}/${electionId}/{z}/{x}/{y}.mvt`],
      minzoom: 0,
      maxzoom: 18,
    },
  };
}

export function buildLayers() {
  return [
    // State polygons - choropleth fill driven by % consensus, with a
    // red/orange override when any PU is in conflict / discrepancy.
    {
      id: 'states-fill',
      type: 'fill',
      source: 'openballot',
      'source-layer': 'states',
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: {
        'fill-color': [
          'case',
          ['>', ['get', 'units_inec_conflict'], 0], '#dc2626',
          ['>', ['get', 'units_discrepancy'], 0],   '#f97316',
          // % consensus -> green ramp
          ['>=', ['/', ['to-number', ['get', 'units_consensus']],
                       ['max', ['to-number', ['get', 'pu_count']], 1]], 0.85], '#16a34a',
          ['>=', ['/', ['to-number', ['get', 'units_consensus']],
                       ['max', ['to-number', ['get', 'pu_count']], 1]], 0.5],  '#4ade80',
          ['>', ['get', 'units_reporting'], 0],     '#a3e635',
          '#e5e7eb',
        ],
        'fill-opacity': 0.55,
        'fill-outline-color': '#0f172a',
      },
    },
    // Focused state outline: when the user has drilled into a state,
    // its polygon gets a thick blue stroke. The renderer drives this
    // via the layer filter (set in applyFocusLayers).
    {
      id: 'states-focus-outline',
      type: 'line',
      source: 'openballot',
      'source-layer': 'states',
      filter: ['all',
        ['==', ['geometry-type'], 'Polygon'],
        ['==', ['get', 'state_code'], '__none__'],
      ],
      paint: {
        'line-color': '#1d4ed8',
        'line-width': 2.5,
        'line-opacity': 0.9,
      },
    },
    // Centroid fallback for states without a polygon loaded.
    {
      id: 'states-circles',
      type: 'circle',
      source: 'openballot',
      'source-layer': 'states',
      filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-radius': radiusByPuCount(5, 14, 28),
        'circle-color': '#0f172a',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1.2,
        'circle-opacity': 0.85,
      },
    },
    // LGA proportional symbols. Visibility is driven by focus, not zoom.
    {
      id: 'lgas-circles',
      type: 'circle',
      source: 'openballot',
      'source-layer': 'lgas',
      layout: { visibility: 'none' },
      paint: {
        'circle-radius': radiusByPuCount(4, 12, 22),
        'circle-color': verifiedRamp(),
        'circle-stroke-color': conflictStroke(),
        'circle-stroke-width': 1.2,
        'circle-opacity': 0.85,
      },
    },
    // Ward proportional symbols. Visibility driven by focus.
    {
      id: 'wards-circles',
      type: 'circle',
      source: 'openballot',
      'source-layer': 'wards',
      layout: { visibility: 'none' },
      paint: {
        'circle-radius': radiusByPuCount(3, 10, 18),
        'circle-color': verifiedRamp(),
        'circle-stroke-color': conflictStroke(),
        'circle-stroke-width': 1,
        'circle-opacity': 0.8,
      },
    },
    // Individual polling units. ONLY ever shown when the user has
    // drilled into a single ward (MapboxRenderer toggles visibility on
    // focus change). Ward sizes are 5..~282 PUs — always readable.
    {
      id: 'polling-units',
      type: 'circle',
      source: 'openballot',
      'source-layer': 'polling_units',
      layout: { visibility: 'none' },
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 4, 14, 7, 17, 11],
        'circle-color': colourByStatus,
        'circle-stroke-color': '#0f172a',
        'circle-stroke-width': 0.5,
        'circle-stroke-opacity': 0.6,
      },
    },
  ];
}

export const NIGERIA_BOUNDS: [number, number, number, number] = [
  2.7,  // west lng
  4.0,  // south lat
  14.7, // east lng
  14.0, // north lat
];

export const NIGERIA_CENTER: [number, number] = [8.7, 9.1];
