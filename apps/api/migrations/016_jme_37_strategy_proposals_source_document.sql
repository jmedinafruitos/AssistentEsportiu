-- JME-37: let a strategy-change proposal come from a Drive document
-- (JME-34) in addition to a coordinator's manual edit. Nullable — manual
-- proposals keep working with no source document. No change to the
-- existing pending/applied/rejected/superseded flow from JME-11.

ALTER TABLE strategy_change_proposals
  ADD COLUMN IF NOT EXISTS source_document_id UUID REFERENCES source_documents(id);
