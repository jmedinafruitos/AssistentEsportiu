-- JME-58: structured link from an exercise to the content it delivers,
-- replacing free-text tag matching against the taxonomy for this
-- purpose (exercises.tags stays for general search/filtering).
CREATE TABLE exercise_content_tags (
  exercise_id UUID NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
  content_taxonomy_id UUID NOT NULL REFERENCES content_taxonomy(id) ON DELETE CASCADE,
  PRIMARY KEY (exercise_id, content_taxonomy_id)
);

CREATE INDEX exercise_content_tags_taxonomy_idx ON exercise_content_tags (content_taxonomy_id);
