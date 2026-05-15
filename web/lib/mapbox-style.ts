// Mapbox GL JS layer + source configuration for the OpenBallot results map.
//
// One vector source - our /api/v1/tiles endpoint. The server picks the
// right layer per zoom band (states / lgas / wards / polling_units), so
// we declare one source-layer per band and let Mapbox switch between
// them based on `minzoom`/`maxzoom`.
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

// Mapbox `match` expression as nested array - typed as `any[]` because
// Mapbox's TypeScript types for expressions don't compose well otherwise.
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
    {
      id: 'states-circles',
      type: 'circle',
      source: 'openballot',
      'source-layer': 'states',
      minzoom: 0,
      maxzoom: 6,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 0, 6, 5, 18],
        'circle-color': '#0f172a',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1.5,
        'circle-opacity': 0.85,
      },
    },
    {
      id: 'lgas-circles',
      type: 'circle',
      source: 'openballot',
      'source-layer': 'lgas',
      minzoom: 6,
      maxzoom: 9,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 3, 8, 7],
        'circle-color': '#0f172a',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1,
        'circle-opacity': 0.7,
      },
    },
    {
      id: 'wards-circles',
      type: 'circle',
      source: 'openballot',
      'source-layer': 'wards',
      minzoom: 9,
      maxzoom: 11,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 2, 10, 4],
        'circle-color': '#475569',
        'circle-opacity': 0.6,
      },
    },
    {
      id: 'polling-units',
      type: 'circle',
      source: 'openballot',
      'source-layer': 'polling_units',
      minzoom: 11,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 2, 14, 5, 17, 9],
        'circle-color': colourByStatus,
        'circle-stroke-color': '#0f172a',
        'circle-stroke-width': 0.4,
        'circle-stroke-opacity': 0.5,
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
