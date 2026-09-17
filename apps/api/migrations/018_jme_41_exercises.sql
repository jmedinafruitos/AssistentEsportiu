-- JME-41: catalog of reusable exercises/games from the reference manuals
-- (252 exercicis, Juegos con Patines, Programación base y ejercicios) —
-- today they're buried in PDFs with nowhere consultable to live.

CREATE TABLE IF NOT EXISTS exercises (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('juego', 'circuito', 'ejercicio', 'tactica')),
  description TEXT,
  variants TEXT[] NOT NULL DEFAULT '{}',
  tags TEXT[] NOT NULL DEFAULT '{}',
  source_document_id UUID REFERENCES source_documents(id),
  page_ref TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS exercises_type_idx ON exercises (type);
CREATE INDEX IF NOT EXISTS exercises_tags_idx ON exercises USING GIN (tags);
