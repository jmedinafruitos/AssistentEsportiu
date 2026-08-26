-- Estrategia oficial confirmada para Escoleta/Iniciació.
UPDATE categories
SET age_from = 3,
    age_to = 8
WHERE name = 'Escoleta';

UPDATE strategy_contexts
SET content = jsonb_build_object(
  'key', 'category-escoleta-v1',
  'name', 'Escoleta/Iniciació',
  'age_range', jsonb_build_object('from', 3, 'to', 8),
  'status', 'official',
  'main_objective', 'Conèixer les nocions bàsiques de l''hoquei patins, aprenent sobretot a patinar i a jugar amb l''stick.',
  'priority_order', jsonb_build_array('Diversió i gaudi', 'Seguretat', 'Patinatge i equilibri', 'Coordinació', 'Familiarització amb l''stick i la bola', 'Relació amb el grup'),
  'development_benefits', jsonb_build_array(
    jsonb_build_object('area', 'Habilitats motrius', 'description', 'Desenvolupar habilitats motrius bàsiques com córrer, saltar, llançar i atrapar.'),
    jsonb_build_object('area', 'Regles senzilles', 'description', 'Començar a entendre regles bàsiques, normes i límits.'),
    jsonb_build_object('area', 'Socialització', 'description', 'Interactuar, jugar amb altres infants i participar en el joc de grup.'),
    jsonb_build_object('area', 'Coordinació', 'description', 'Millorar la coordinació ull-mà i la coordinació motora grossa.'),
    jsonb_build_object('area', 'Cooperació', 'description', 'Iniciar la comprensió de la cooperació i del treball en equip.'),
    jsonb_build_object('area', 'Salut', 'description', 'Afavorir l''exercici regular i la salut física general.'),
    jsonb_build_object('area', 'Confiança', 'description', 'Construir confiança a partir de petits èxits i assoliments.'),
    jsonb_build_object('area', 'Respecte', 'description', 'Aprendre a respectar companys, companyes i entrenadors/es.'),
    jsonb_build_object('area', 'Llenguatge', 'description', 'Practicar habilitats lingüístiques en la comunicació amb el grup.'),
    jsonb_build_object('area', 'Hàbits saludables', 'description', 'Establir una relació positiva i duradora amb l''activitat física.')
  ),
  'coach_guidance', jsonb_build_array(
    'Prioritzar consignes molt breus, demostració i joc.',
    'No aplicar objectius tàctics o tècnics propis de Prebenjamí.',
    'Valorar la participació, el gaudi, la seguretat i la progressió individual.'
  )
)
WHERE content->>'key' = 'category-escoleta-v1'
  AND content->>'status' = 'pending_official_programming';
