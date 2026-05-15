-- OpenBallot Nigeria - seed data for development
-- A trimmed slice of the real geography so the local stack boots with a
-- usable map: 4 states, a handful of LGAs, wards, and 12 polling units.

BEGIN;

INSERT INTO states (code, name, zone) VALUES
  ('LA', 'Lagos',   'SW'),
  ('KN', 'Kano',    'NW'),
  ('RI', 'Rivers',  'SS'),
  ('FC', 'FCT',     'FCT');

INSERT INTO lgas (code, name, state_code) VALUES
  ('LA-SUR', 'Surulere',     'LA'),
  ('LA-IKJ', 'Ikeja',        'LA'),
  ('KN-NAS', 'Nasarawa',     'KN'),
  ('KN-FAG', 'Fagge',        'KN'),
  ('RI-PHC', 'Port Harcourt','RI'),
  ('FC-AMA', 'AMAC',         'FC');

INSERT INTO wards (code, name, lga_code) VALUES
  ('LA-SUR-04', 'Surulere Ward 4',  'LA-SUR'),
  ('LA-IKJ-02', 'Ikeja Ward 2',     'LA-IKJ'),
  ('KN-NAS-01', 'Nasarawa Ward 1',  'KN-NAS'),
  ('KN-FAG-03', 'Fagge Ward 3',     'KN-FAG'),
  ('RI-PHC-05', 'PHC Ward 5',       'RI-PHC'),
  ('FC-AMA-09', 'Garki Ward 9',     'FC-AMA');

INSERT INTO polling_units (pu_code, pu_name, ward_code, lga_code, state_code, geog, registered_voters) VALUES
  ('25-11-04-001', 'Surulere Ward 4 / Unit 1',  'LA-SUR-04', 'LA-SUR', 'LA', ST_GeogFromText('SRID=4326;POINT(3.3515 6.4969)'), 412),
  ('25-11-04-007', 'Surulere Ward 4 / Unit 7',  'LA-SUR-04', 'LA-SUR', 'LA', ST_GeogFromText('SRID=4326;POINT(3.3522 6.4974)'), 387),
  ('25-11-04-019', 'Surulere Ward 4 / Unit 19', 'LA-SUR-04', 'LA-SUR', 'LA', ST_GeogFromText('SRID=4326;POINT(3.3548 6.4991)'), 511),
  ('25-04-02-003', 'Ikeja Ward 2 / Unit 3',     'LA-IKJ-02', 'LA-IKJ', 'LA', ST_GeogFromText('SRID=4326;POINT(3.3491 6.6018)'), 442),
  ('20-08-01-002', 'Nasarawa Ward 1 / Unit 2',  'KN-NAS-01', 'KN-NAS', 'KN', ST_GeogFromText('SRID=4326;POINT(8.5167 12.0022)'), 398),
  ('20-08-01-014', 'Nasarawa Ward 1 / Unit 14', 'KN-NAS-01', 'KN-NAS', 'KN', ST_GeogFromText('SRID=4326;POINT(8.5189 12.0041)'), 504),
  ('20-09-03-006', 'Fagge Ward 3 / Unit 6',     'KN-FAG-03', 'KN-FAG', 'KN', ST_GeogFromText('SRID=4326;POINT(8.5256 12.0094)'), 467),
  ('33-15-05-001', 'PHC Ward 5 / Unit 1',       'RI-PHC-05', 'RI-PHC', 'RI', ST_GeogFromText('SRID=4326;POINT(7.0134 4.8156)'),  389),
  ('33-15-05-008', 'PHC Ward 5 / Unit 8',       'RI-PHC-05', 'RI-PHC', 'RI', ST_GeogFromText('SRID=4326;POINT(7.0148 4.8171)'),  452),
  ('07-01-09-002', 'Garki Ward 9 / Unit 2',     'FC-AMA-09', 'FC-AMA', 'FC', ST_GeogFromText('SRID=4326;POINT(7.4868 9.0563)'),  428),
  ('07-01-09-011', 'Garki Ward 9 / Unit 11',    'FC-AMA-09', 'FC-AMA', 'FC', ST_GeogFromText('SRID=4326;POINT(7.4892 9.0581)'),  401),
  ('07-01-09-017', 'Garki Ward 9 / Unit 17',    'FC-AMA-09', 'FC-AMA', 'FC', ST_GeogFromText('SRID=4326;POINT(7.4914 9.0599)'),  376);

INSERT INTO parties (code, name, colour_hex) VALUES
  ('APC',  'All Progressives Congress',     '#1f4e9c'),
  ('PDP',  'Peoples Democratic Party',      '#c0392b'),
  ('LP',   'Labour Party',                  '#2ecc71'),
  ('NNPP', 'New Nigeria Peoples Party',     '#f39c12'),
  ('ADC',  'African Democratic Congress',   '#8e44ad');

INSERT INTO elections (id, election_type, scope, election_date, status) VALUES
  ('2027-presidential', 'presidential', 'national', '2027-02-27', 'upcoming'),
  ('2026-edo-gov',      'governorship', 'ED',       '2026-09-19', 'concluded');

INSERT INTO election_candidates (election_id, party_code, candidate_name, running_mate, display_order) VALUES
  ('2027-presidential', 'APC',  'Candidate A', 'Running Mate A', 1),
  ('2027-presidential', 'PDP',  'Candidate B', 'Running Mate B', 2),
  ('2027-presidential', 'LP',   'Candidate C', 'Running Mate C', 3),
  ('2027-presidential', 'NNPP', 'Candidate D', 'Running Mate D', 4);

COMMIT;

-- Refresh tile-cache materialised views now that polling_units is loaded.
-- The views are created in migration 0006 over an empty table so they stay
-- empty until something refreshes them. Wrap in a DO block so the seed
-- still applies cleanly when migration 0006 has not run yet (e.g. older
-- environments).
DO $$
BEGIN
  PERFORM refresh_tile_caches();
EXCEPTION
  WHEN undefined_function THEN
    NULL;
END $$;
