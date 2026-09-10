-- JME-34: track provenance of each document ingested from the Drive folder
-- `EstrategiaHCS`, so any future strategy-change proposal is traceable back
-- to the document it came from. Registration only — no content extraction
-- (JME-36) and no proposal generation (JME-38) here.

CREATE TABLE IF NOT EXISTS source_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  drive_file_id TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  layer TEXT NOT NULL CHECK (layer IN ('principios', 'estructura', 'recursos')),
  category_scope TEXT[] NOT NULL DEFAULT '{}',
  content_hash TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  drive_url TEXT NOT NULL,
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'nuevo' CHECK (status IN ('nuevo', 'en_revision', 'integrado', 'descartado')),
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The detection job (JME-35) and the proposal generator (JME-38) both scan
-- for documents pending action, filtered by status.
CREATE INDEX IF NOT EXISTS source_documents_status_idx
  ON source_documents (status, ingested_at DESC);
