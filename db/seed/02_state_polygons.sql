-- OpenBallot Nigeria - Demo state polygons.
--
-- VERY simplified rectangular bounds for the four demo states.
-- These are placeholders so a fresh clone shows choropleth fills
-- instead of centroid dots; operators load real Nigerian state
-- polygons via scripts/load_state_polygons.py from OCHA/HDX or any
-- equivalent admin-boundary GeoJSON dataset.

BEGIN;

INSERT INTO state_boundaries (state_code, geog, source) VALUES
  ('LA', ST_GeogFromText('SRID=4326;MULTIPOLYGON(((2.7 6.3, 4.3 6.3, 4.3 6.8, 2.7 6.8, 2.7 6.3)))'), 'demo-bbox'),
  ('KN', ST_GeogFromText('SRID=4326;MULTIPOLYGON(((7.7 11.3, 9.6 11.3, 9.6 12.6, 7.7 12.6, 7.7 11.3)))'), 'demo-bbox'),
  ('RI', ST_GeogFromText('SRID=4326;MULTIPOLYGON(((6.3 4.4, 7.7 4.4, 7.7 5.3, 6.3 5.3, 6.3 4.4)))'), 'demo-bbox'),
  ('FC', ST_GeogFromText('SRID=4326;MULTIPOLYGON(((6.9 8.4, 7.9 8.4, 7.9 9.4, 6.9 9.4, 6.9 8.4)))'), 'demo-bbox')
ON CONFLICT (state_code) DO NOTHING;

COMMIT;
