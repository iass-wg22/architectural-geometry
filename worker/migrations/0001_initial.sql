CREATE TABLE IF NOT EXISTS suggestions (
  id TEXT NOT NULL PRIMARY KEY,
  record_version INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  moderation_status TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  suggestion_json TEXT NOT NULL,
  delivery_status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  CHECK (record_version >= 1),
  CHECK (schema_version >= 1),
  CHECK (json_valid(suggestion_json))
);

CREATE INDEX IF NOT EXISTS suggestions_delivery_status_idx
  ON suggestions (delivery_status);

CREATE INDEX IF NOT EXISTS suggestions_submitted_at_idx
  ON suggestions (submitted_at);