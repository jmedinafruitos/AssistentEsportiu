-- JME-49: players table + initial roster seed from the club's source-of-truth
-- spreadsheet (HCS_jugadors i equips.xlsx, 2026/2027 season). Cross-checked
-- and resolved with Jordi:
--   - "FEM 15".."FEM 21" (7 single-player entries, all born 2012, coached
--     by Joan Sole, same coach as FEM13/FEM15) were a spreadsheet artifact,
--     not real teams — merged into FEM15.
--   - 1CAT/2CAT are real adult teams not yet in the system — added here
--     under a new "Sènior" category.
--   - Gisela Requena and Vega Carretero: home team FEM13 (borrowed on
--     Alevín for matches). Martí Muñoz: home team Alevín (borrowed on
--     Infantil B). Virtual teams (Alevín Bronze, Infantil Plata C/D) are
--     skipped entirely — their listed rosters are 100% players already
--     seeded under their real home team, confirming the JME-52 design
--     that virtual teams borrow every player at match time.
-- Names are imported exactly as written in the source spreadsheet
-- (whitespace-trimmed only) rather than auto-title-cased, to avoid
-- mangling Catalan orthography (e.g. "Gal·la").

INSERT INTO categories (name, age_from, age_to, active)
VALUES ('Sènior', 16, NULL, true)
ON CONFLICT (name) DO NOTHING;

WITH adult_teams(name, category_name) AS (
  VALUES ('1CAT', 'Sènior'), ('2CAT', 'Sènior')
)
INSERT INTO teams (name, category_id, season, active)
SELECT at.name, c.id, '2026/2027', true
FROM adult_teams at
JOIN categories c ON c.name = at.category_name
WHERE NOT EXISTS (
  SELECT 1 FROM teams t WHERE t.name = at.name AND t.season = '2026/2027'
);

CREATE TABLE IF NOT EXISTS players (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  team_id UUID NOT NULL REFERENCES teams(id),
  birth_year SMALLINT,
  is_goalkeeper BOOLEAN NOT NULL DEFAULT false,
  active BOOLEAN NOT NULL DEFAULT true,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS players_team_idx ON players (team_id) WHERE active = true;

WITH roster(name, team_name, birth_year, is_goalkeeper) AS (
  VALUES
  ('BIEL SANZ', 'Escoleta Iniciació', 2022, false),
  ('ORIOL VILLORA', 'Escoleta Iniciació', 2022, false),
  ('TONI SORIANO', 'Escoleta Iniciació', 2022, false),
  ('RA DAVINS', 'Escoleta Iniciació', 2022, false),
  ('MARTI CATALAN', 'Escoleta Iniciació', 2022, false),
  ('GUIM', 'Escoleta Iniciació', 2022, false),
  ('ARIANNA AULEDA', 'Escoleta Iniciació', 2021, false),
  ('ADAY', 'Escoleta Iniciació', 2021, false),
  ('THAIS', 'Escoleta Iniciació', 2021, false),
  ('JULEN', 'Escoleta Iniciació', 2021, false),
  ('ARLET', 'Escoleta Iniciació', 2021, false),
  ('OLIVER RODRIGUEZ', 'Prebenjamín', 2019, true),
  ('MAX BERMUDEZ', 'Prebenjamín', 2019, true),
  ('TONI GARCIA', 'Prebenjamín', 2019, false),
  ('ERIC GARCIA', 'Prebenjamín', 2019, false),
  ('NIL YANG', 'Prebenjamín', 2019, false),
  ('EIDEN SANCHEZ', 'Prebenjamín', 2019, false),
  ('ARAN ABRIL', 'Prebenjamín', 2019, false),
  ('PAU COBO', 'Prebenjamín', 2019, false),
  ('ROGER JUAN', 'Benjamín', 2016, true),
  ('DRAC SOLER', 'Benjamín', 2017, true),
  ('MARC MONFORTE', 'Benjamín', 2016, false),
  ('ENRIC CABRERA', 'Benjamín', 2016, false),
  ('ARES CAPELLA', 'Benjamín', 2017, false),
  ('JAUME PERICH', 'Benjamín', 2017, false),
  ('ARAN GARCIA', 'Benjamín', 2017, false),
  ('IVET PEREZ', 'Benjamín', 2017, false),
  ('CESC BALAT', 'Alevín', 2014, true),
  ('HÉCTOR RODRÍGUEZ', 'Alevín', 2014, false),
  ('SERGI LINARES', 'Alevín', 2014, false),
  ('MIQUEL HERNÁNDEZ', 'Alevín', 2014, false),
  ('ROC ROIG', 'Alevín', 2014, false),
  ('ROC SOLER', 'Alevín', 2014, false),
  ('ARNAU ALCAYNA', 'Alevín', 2014, false),
  ('MARTÍ MUÑOZ', 'Alevín', 2014, false),
  ('AINA YANG', 'FEM13', 2014, true),
  ('GISELA REQUENA', 'FEM13', 2014, true),
  ('PAULA GARCIA', 'FEM13', 2014, false),
  ('PAULA MÉNDEZ', 'FEM13', 2014, false),
  ('BERTA GRACIA', 'FEM13', 2014, false),
  ('PAULA ALCAIDE', 'FEM13', 2014, false),
  ('VEGA CARRETERO', 'FEM13', 2015, false),
  ('GAL·LA GARCIA', 'FEM13', 2015, false),
  ('JULIA PÉREZ', 'FEM13', 2015, false),
  ('MARTÍ LOZANO', 'Infantil B', 2013, true),
  ('FERRAN GUTIÉRREZ', 'Infantil B', 2013, false),
  ('PAU PELAYO', 'Infantil B', 2013, true),
  ('NIL FINESTRES', 'Infantil B', 2013, false),
  ('JORDI ORTEGA', 'Infantil B', 2013, false),
  ('BIEL PÉREZ', 'Infantil B', 2013, false),
  ('LLUC GUTIÉRREZ', 'Infantil A', 2012, true),
  ('ARATZ CAÑETE', 'Infantil A', 2012, false),
  ('BIEL INSUA', 'Infantil A', 2012, false),
  ('EDWARD TURMO', 'Infantil A', 2012, false),
  ('JORDI SÁNCHEZ', 'Infantil A', 2012, false),
  ('MARC TRUJILLO', 'Infantil A', 2012, false),
  ('MARTÍ ALCÁZAR', 'Infantil A', 2012, false),
  ('MARTÍ NAVARRO', 'Infantil A', 2012, false),
  ('MIREIA PALACIOS', 'FEM15', 2012, true),
  ('ONA YANG', 'FEM15', 2012, false),
  ('IRIS ROIG', 'FEM15', 2012, false),
  ('MARÍA NÚÑEZ', 'FEM15', 2012, false),
  ('LOLA', 'FEM15', 2012, false),
  ('CLARA', 'FEM15', 2012, false),
  ('EMMA SIBINA', 'FEM15', 2012, false),
  ('ALBERT LLOPART', '2CAT', 2007, true),
  ('ERIC MOYANO', '2CAT', 2010, true),
  ('RAMON VILA', '2CAT', 2000, false),
  ('ROGER ACSENSI', '2CAT', 1996, false),
  ('MARC GARCIA', '2CAT', 1996, false),
  ('JAUME FRANCISCO', '2CAT', 1996, false),
  ('CUSPI', '2CAT', 2001, false),
  ('BIEL CORDÓN', '2CAT', 2006, false),
  ('ADRI ARCO', '2CAT', 2007, false),
  ('BIEL MEDINA', '2CAT', 2007, false),
  ('ARTUR CAPEL', '2CAT', 2007, false),
  ('MENNA LÓPEZ', '2CAT', 2003, false),
  ('POL LÓPEZ', '1CAT', 2001, true),
  ('BERNAT GONZÁLEZ', '1CAT', 2000, true),
  ('ÁLEX PALAZÓN', '1CAT', 1989, false),
  ('MARC PALAZÓN', '1CAT', 1996, false),
  ('JESÚS LÓPEZ', '1CAT', 2001, false),
  ('XAVI VALERO', '1CAT', 2002, false),
  ('PAU ZAMORA', '1CAT', 2002, false),
  ('NIL FOLGUERA', '1CAT', 2002, false),
  ('MARTI FRANCISCO', '1CAT', 2001, false),
  ('JAVI LOMAS', '1CAT', 2003, false)
)
INSERT INTO players (name, team_id, birth_year, is_goalkeeper)
SELECT r.name, t.id, r.birth_year, r.is_goalkeeper
FROM roster r
JOIN teams t ON t.name = r.team_name AND t.season = '2026/2027'
WHERE NOT EXISTS (
  SELECT 1 FROM players p WHERE p.name = r.name AND p.team_id = t.id
);
