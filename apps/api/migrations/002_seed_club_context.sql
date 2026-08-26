-- Datos iniciales confirmados para Hoquei Club Sentmenat.
-- Esta migración no crea usuarios ni equipos: se añadirán cuando el coordinador los confirme.

INSERT INTO categories (name, age_from, age_to)
VALUES
  ('Escoleta', NULL, 8),
  ('Prebenjamín', 9, 10),
  ('Benjamín', 11, 12),
  ('Alevín', 13, 14),
  ('Infantil', 15, 16),
  ('Juvenil', 16, 17),
  ('Júnior', 18, 19)
ON CONFLICT (name) DO UPDATE
SET age_from = EXCLUDED.age_from,
    age_to = EXCLUDED.age_to,
    active = true;

INSERT INTO strategy_contexts (scope, content)
SELECT 'club',
  jsonb_build_object(
    'key', 'club-strategy-v1',
    'club_name', 'Hoquei Club Sentmenat',
    'season', jsonb_build_object('starts_in', 'September', 'ends_in', 'June'),
    'category_cycle', jsonb_build_object('seasons_per_category', 2),
    'purpose', 'Coordinar una estrategia deportiva común y acompañar la planificación y el seguimiento de equipos.',
    'strategy_axes', jsonb_build_array('Evolución individual', 'Evolución de equipo'),
    'official_source', jsonb_build_object(
      'title', 'La programación en el hockey sobre patines',
      'role', 'Documento rector para la planificación de temporada por categoría y primer/segundo año.',
      'rule', 'Las propuestas de planificación deben respetar esta programación.'
    ),
    'complementary_sources', jsonb_build_array(
      jsonb_build_object('title', 'Introducció a la tàctica', 'role', 'Conceptos de táctica y toma de decisiones.'),
      jsonb_build_object('title', 'Bloc I: Escola/Prebenjamí', 'role', 'Táctica de iniciación.'),
      jsonb_build_object('title', 'Bloc II: Benjamí', 'role', 'Táctica de Benjamín.'),
      jsonb_build_object('title', 'La tècnica', 'role', 'Fundamentos técnico-tácticos, patinaje y seguridad.'),
      jsonb_build_object('title', 'Metodologia', 'role', 'Diseño de juegos, tareas y partidos.' )
    ),
    'source_hierarchy_rule', 'Los documentos complementarios enriquecen ejercicios y sesiones, pero no sustituyen ni cambian la programación oficial.',
    'female_teams', jsonb_build_object('reference_teams', jsonb_build_array('FEM13', 'FEM15'), 'rule', 'Su equipo base es el femenino; la participación en mixtos es complementaria.'),
    'senior_scope', jsonb_build_object('teams', jsonb_build_array('Primera Catalana', 'Segunda Catalana'), 'included_in_current_phase', false)
  )
WHERE NOT EXISTS (
  SELECT 1 FROM strategy_contexts WHERE content->>'key' = 'club-strategy-v1'
);

INSERT INTO strategy_contexts (scope, category_id, content)
SELECT 'category', c.id,
  CASE c.name
    WHEN 'Escoleta' THEN jsonb_build_object(
      'key', 'category-escoleta-v1',
      'status', 'pending_official_programming',
      'focus', jsonb_build_array('Seguridad', 'Familiarización con patines y material', 'Equilibrio', 'Coordinación', 'Disfrute'),
      'rule', 'No aplicar automáticamente la programación de Prebenjamín.'
    )
    WHEN 'Prebenjamín' THEN jsonb_build_object(
      'key', 'category-prebenjamin-v1',
      'source_programming', 'La programación en el hockey sobre patines',
      'years', jsonb_build_array('Primer año', 'Segundo año'),
      'content_blocks', jsonb_build_array('Patinaje', 'Dominio de bola', 'Pase/recepción', 'Finalización', 'Táctica individual'),
      'tactical_reference', 'Bloc I: Escola/Prebenjamí'
    )
    WHEN 'Benjamín' THEN jsonb_build_object(
      'key', 'category-benjamin-v1',
      'source_programming', 'La programación en el hockey sobre patines',
      'years', jsonb_build_array('Primer año', 'Segundo año'),
      'content_blocks', jsonb_build_array('Patinaje', 'Dominio de bola', 'Pase/recepción', 'Finalización', 'Táctica y fundamentos básicos de trabajo'),
      'tactical_reference', 'Bloc II: Benjamí'
    )
    WHEN 'Alevín' THEN jsonb_build_object(
      'key', 'category-alevin-v1',
      'source_programming', 'La programación en el hockey sobre patines',
      'years', jsonb_build_array('Primer año', 'Segundo año'),
      'content_blocks', jsonb_build_array('Técnica con oposición', 'Pase/recepción dinámica', 'Finalización', 'Táctica colectiva', 'Sistemas iniciales')
    )
    WHEN 'Infantil' THEN jsonb_build_object(
      'key', 'category-infantil-v1',
      'source_programming', 'La programación en el hockey sobre patines',
      'years', jsonb_build_array('Primer año', 'Segundo año'),
      'content_blocks', jsonb_build_array('Preparación física', 'Técnico-táctico', 'Fundamentos de trabajo por grupos', 'Sistemas')
    )
    WHEN 'Juvenil' THEN jsonb_build_object(
      'key', 'category-juvenil-v1',
      'source_programming', 'La programación en el hockey sobre patines',
      'stage', 'Perfeccionamiento',
      'content_blocks', jsonb_build_array('Preparación física', 'Técnico-táctico', 'Táctica colectiva', 'Sistemas')
    )
    WHEN 'Júnior' THEN jsonb_build_object(
      'key', 'category-junior-v1',
      'source_programming', 'La programación en el hockey sobre patines',
      'stage', 'Perfeccionamiento',
      'content_blocks', jsonb_build_array('Preparación física', 'Técnico-táctico', 'Táctica colectiva', 'Sistemas')
    )
  END
FROM categories c
WHERE c.name IN ('Escoleta', 'Prebenjamín', 'Benjamín', 'Alevín', 'Infantil', 'Juvenil', 'Júnior')
  AND NOT EXISTS (
  SELECT 1 FROM strategy_contexts sc WHERE sc.content->>'key' = 'category-' || lower(replace(replace(c.name, 'í', 'i'), 'ú', 'u')) || '-v1'
);
