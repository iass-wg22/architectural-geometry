ALTER TABLE suggestions
ADD COLUMN github_issue_number INTEGER;

ALTER TABLE suggestions
ADD COLUMN github_issue_url TEXT;

ALTER TABLE suggestions
ADD COLUMN delivery_attempt_count INTEGER
NOT NULL DEFAULT 0
CHECK (delivery_attempt_count >= 0);

ALTER TABLE suggestions
ADD COLUMN delivery_last_error TEXT;

ALTER TABLE suggestions
ADD COLUMN delivery_next_attempt_at TEXT;

ALTER TABLE suggestions
ADD COLUMN delivered_at TEXT;

CREATE UNIQUE INDEX
IF NOT EXISTS suggestions_github_issue_number_unique
ON suggestions (github_issue_number)
WHERE github_issue_number IS NOT NULL;

CREATE INDEX
IF NOT EXISTS suggestions_delivery_due
ON suggestions (
  delivery_status,
  delivery_next_attempt_at
);