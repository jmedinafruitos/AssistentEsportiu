-- JME-57: per-category content catalog for training sessions. A
-- free-depth tree (block > subblock > ...) rather than a fixed 2-level
-- shape — categories may need more/fewer levels later. Each category
-- owns its own tree; nothing is shared across categories even when two
-- categories happen to have similar-looking blocks.

CREATE TABLE content_taxonomy (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id UUID NOT NULL REFERENCES categories(id),
  parent_id UUID REFERENCES content_taxonomy(id),
  code TEXT NOT NULL,
  label TEXT NOT NULL,
  example_text TEXT,
  order_index INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX content_taxonomy_category_idx ON content_taxonomy (category_id);
CREATE INDEX content_taxonomy_parent_idx ON content_taxonomy (parent_id);

-- Starting catalog for Prebenjamín + Benjamín, deliberately just 2
-- blocks x 2 subblocks each (Jordi's call — expand later, not now).
DO $$
DECLARE
  cat RECORD;
  block_tecnica UUID;
  block_tactica UUID;
BEGIN
  FOR cat IN SELECT id FROM categories WHERE name IN ('Prebenjamín', 'Benjamín') LOOP
    INSERT INTO content_taxonomy (category_id, parent_id, code, label, order_index)
      VALUES (cat.id, NULL, '1', 'Tècnica individual', 1)
      RETURNING id INTO block_tecnica;
    INSERT INTO content_taxonomy (category_id, parent_id, code, label, example_text, order_index) VALUES
      (cat.id, block_tecnica, '1.1', 'Escalfament i tècnica de patí', 'Voltes a la pista', 1),
      (cat.id, block_tecnica, '1.2', 'Tècnica de patí amb estic-bola', 'Circuits i jocs', 2);

    INSERT INTO content_taxonomy (category_id, parent_id, code, label, order_index)
      VALUES (cat.id, NULL, '2', 'Tàctica individual i grupal', 2)
      RETURNING id INTO block_tactica;
    INSERT INTO content_taxonomy (category_id, parent_id, code, label, example_text, order_index) VALUES
      (cat.id, block_tactica, '2.1', 'Tàctica individual', 'Dribling, passar i tallar, 1v1, defensa individual', 1),
      (cat.id, block_tactica, '2.2', 'Tàctica grupal', 'Sortida per banda, fixar els 4 en replegament', 2);
  END LOOP;
END $$;
