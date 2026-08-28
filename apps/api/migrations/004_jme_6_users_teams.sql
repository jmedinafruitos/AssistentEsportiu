-- JME-6: initial preproduction identities, teams and server-side access scope.
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'club_admin';

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS sport_role TEXT,
  ADD COLUMN IF NOT EXISTS global_access BOOLEAN NOT NULL DEFAULT false;

-- Keep the confirmed 2026/2027 category ranges repeatable across deployments.
INSERT INTO categories (name, age_from, age_to, active)
VALUES
  ('Prebenjamín Iniciación', 4, 6, true),
  ('Prebenjamín', 7, 8, true),
  ('Benjamín', 9, 10, true),
  ('Alevín', 11, 12, true),
  ('Infantil', 13, 14, true),
  ('Juvenil', 15, 16, true),
  ('Júnior', 17, 18, true)
ON CONFLICT (name) DO UPDATE
SET age_from = EXCLUDED.age_from,
    age_to = EXCLUDED.age_to,
    active = true;

-- Move the historical Escoleta context to the confirmed initiation category,
-- then remove the obsolete category inserted by older migrations.
UPDATE strategy_contexts sc
SET category_id = target.id
FROM categories old_category, categories target
WHERE old_category.name = 'Escoleta'
  AND target.name = 'Prebenjamín Iniciación'
  AND sc.category_id = old_category.id;

UPDATE teams t
SET category_id = target.id
FROM categories old_category, categories target
WHERE old_category.name = 'Escoleta'
  AND target.name = 'Prebenjamín Iniciación'
  AND t.category_id = old_category.id;

DELETE FROM categories WHERE name = 'Escoleta';

INSERT INTO users (name, email, role, sport_role, global_access, active)
VALUES
  ('Jordi Medina', 'jordi@medina.cat', 'club_admin', 'Entrenador', true, true),
  ('Paco González', 'pako1515@gmail.com', 'club_admin', 'Coordinador deportivo', true, true),
  ('Menna López', 'mennalopez1@gmail.com', 'coach', 'Coentrenador', false, true),
  ('Biel Cordón', 'bielcordon@gmail.com', 'coach', 'Entrenador', false, true),
  ('Keisa', 'keisahcsentmenat@gmail.com', 'coach', 'Entrenadora', false, true),
  ('Joan', 'pratssolejoan@gmail.com', 'coach', 'Entrenador', false, true),
  ('Juan Carlos', 'jcarlospr04@gmail.com', 'coach', 'Entrenador', false, true)
ON CONFLICT (email) DO UPDATE
SET name = EXCLUDED.name,
    role = EXCLUDED.role,
    sport_role = EXCLUDED.sport_role,
    global_access = EXCLUDED.global_access,
    active = true;

WITH required_teams(name, category_name) AS (
  VALUES
    ('Benjamín', 'Benjamín'),
    ('Prebenjamín', 'Prebenjamín'),
    ('Escoleta Iniciació', 'Prebenjamín Iniciación'),
    ('FEM13', 'Alevín'),
    ('FEM15', 'Infantil'),
    ('Alevín', 'Alevín'),
    ('Infantil A', 'Infantil'),
    ('Infantil B', 'Infantil')
)
INSERT INTO teams (name, category_id, season, active)
SELECT rt.name, c.id, '2026/2027', true
FROM required_teams rt
JOIN categories c ON c.name = rt.category_name
WHERE NOT EXISTS (
  SELECT 1 FROM teams t WHERE t.name = rt.name AND t.season = '2026/2027'
);

WITH required_assignments(email, team_name) AS (
  VALUES
    ('jordi@medina.cat', 'Benjamín'),
    ('mennalopez1@gmail.com', 'Benjamín'),
    ('bielcordon@gmail.com', 'Prebenjamín'),
    ('keisahcsentmenat@gmail.com', 'Escoleta Iniciació'),
    ('pratssolejoan@gmail.com', 'FEM13'),
    ('pratssolejoan@gmail.com', 'FEM15'),
    ('jcarlospr04@gmail.com', 'Alevín'),
    ('jcarlospr04@gmail.com', 'Infantil A'),
    ('jcarlospr04@gmail.com', 'Infantil B')
)
INSERT INTO team_assignments (user_id, team_id)
SELECT u.id, t.id
FROM required_assignments ra
JOIN users u ON u.email = ra.email
JOIN teams t ON t.name = ra.team_name AND t.season = '2026/2027'
ON CONFLICT DO NOTHING;

-- Paco's declared assignment is "Todos". Persist every current team relation
-- in addition to global access so reporting reflects that assignment.
INSERT INTO team_assignments (user_id, team_id)
SELECT u.id, t.id
FROM users u
CROSS JOIN teams t
WHERE u.email = 'pako1515@gmail.com'
  AND t.season = '2026/2027'
ON CONFLICT DO NOTHING;
