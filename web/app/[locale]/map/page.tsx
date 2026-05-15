import 'mapbox-gl/dist/mapbox-gl.css';

import { ResultsMap } from '@/components/ResultsMap';

export default function MapPage() {
  return (
    <div className="map-container">
      <ResultsMap electionId="2027-presidential" />
    </div>
  );
}
