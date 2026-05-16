import 'mapbox-gl/dist/mapbox-gl.css';

import { unstable_setRequestLocale } from 'next-intl/server';

import { ResultsMap } from '@/components/ResultsMap';

export default function MapPage({ params }: { params: { locale: string } }) {
  unstable_setRequestLocale(params.locale);
  return (
    <div className="map-container">
      <ResultsMap electionId="2027-presidential" />
    </div>
  );
}
