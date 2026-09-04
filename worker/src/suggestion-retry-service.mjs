import {
  applyAutomaticRetrySchedule,
} from "../../lib/content-suggestions/suggestion-retry-policy.mjs";

import {
  formatSuggestionAsGitHubIssue,
} from "../../lib/content-suggestions/github-issue-formatter.mjs";

export const defaultRetryCycleLimit = 10;

const SELECT_DUE_RETRIES_SQL = `
  SELECT
    id,
    record_version,
    moderation_status,
    submitted_at,
    suggestion_json,
    delivery_status,
    delivery_attempt_count,
    delivery_last_error,
    delivery_next_attempt_at,
    updated_at
  FROM suggestions
  WHERE delivery_status = 'failed'
    AND delivery_next_attempt_at IS NOT NULL
    AND delivery_next_attempt_at <= ?
  ORDER BY delivery_next_attempt_at ASC
  LIMIT ?
`;

function normalizeCurrentDate(value) {
  const date = value instanceof Date
    ? new Date(value.getTime())
    : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error("The retry cycle date is invalid.");
  }

  return date;
}

function normalizeCycleLimit(value) {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error(
      "The retry cycle limit must be an integer between 1 and 100.",
    );
  }

  return value;
}

function normalizeDeliveryError(error) {
  const message = error instanceof Error
    ? error.message
    : String(error ?? "Unknown delivery error.");

  return message.trim().slice(0, 2000) || "Unknown delivery error.";
}

function parseStoredRecord(row) {
  let suggestion;

  try {
    suggestion = JSON.parse(row.suggestion_json);
  } catch (error) {
    throw new Error(
      `Suggestion ${row.id} contains invalid stored JSON: ${error.message}`,
    );
  }

  return {
    recordVersion: row.record_version,
    id: row.id,
    status: row.moderation_status,
    submittedAt: row.submitted_at,
    suggestion,
    delivery: {
      status: row.delivery_status,
      attemptCount: row.delivery_attempt_count,
      lastError: row.delivery_last_error,
      nextRetryAt: row.delivery_next_attempt_at,
    },
  };
}

function getChangedRowCount(result) {
  return result?.meta?.changes ?? result?.changes ?? 0;
}

async function selectDueRetryRows(db, nowIso, limit) {
  const result = await db
    .prepare(SELECT_DUE_RETRIES_SQL)
    .bind(nowIso, limit)
    .all();

  if (result?.success === false || !Array.isArray(result?.results)) {
    throw new Error("D1 did not return the due retry records.");
  }

  return result.results;
}

async function claimRetryRow(db, row, nowIso) {
  const result = await db
    .prepare(`
      UPDATE suggestions
      SET
        delivery_status = 'processing',
        delivery_next_attempt_at = NULL,
        updated_at = ?
      WHERE id = ?
        AND delivery_status = 'failed'
        AND delivery_next_attempt_at = ?
        AND delivery_next_attempt_at <= ?
    `)
    .bind(
      nowIso,
      row.id,
      row.delivery_next_attempt_at,
      nowIso,
    )
    .run();

  if (result?.success === false) {
    throw new Error(`D1 could not claim suggestion ${row.id}.`);
  }

  return getChangedRowCount(result) === 1;
}

function validateGitHubDelivery(result) {
  if (!result || typeof result !== "object") {
    throw new Error("The GitHub delivery result is missing.");
  }

  if (!Number.isInteger(result.issueNumber) || result.issueNumber < 1) {
    throw new Error("The GitHub delivery result has no valid Issue number.");
  }

  if (
    typeof result.issueUrl !== "string" ||
    !/^https:\/\/github\.com\/.+\/issues\/\d+\/?$/i.test(result.issueUrl)
  ) {
    throw new Error("The GitHub delivery result has no valid Issue URL.");
  }

  return {
    issueNumber: result.issueNumber,
    issueUrl: result.issueUrl,
    reused: result.reused === true,
  };
}

async function recordSuccessfulDelivery(
  db,
  suggestionId,
  attemptCount,
  delivery,
  nowIso,
) {
  const result = await db
    .prepare(`
      UPDATE suggestions
      SET
        delivery_status = 'delivered',
        delivery_attempt_count = ?,
        github_issue_number = ?,
        github_issue_url = ?,
        delivery_last_error = NULL,
        delivery_next_attempt_at = NULL,
        delivered_at = ?,
        updated_at = ?
      WHERE id = ?
        AND delivery_status = 'processing'
    `)
    .bind(
      attemptCount,
      delivery.issueNumber,
      delivery.issueUrl,
      nowIso,
      nowIso,
      suggestionId,
    )
    .run();

  if (result?.success === false || getChangedRowCount(result) !== 1) {
    throw new Error(
      `D1 could not record the successful delivery of ${suggestionId}.`,
    );
  }
}

async function recordFailedDelivery(
  db,
  suggestionId,
  attemptCount,
  errorMessage,
  nowIso,
) {
  const scheduledDelivery = applyAutomaticRetrySchedule({
    status: "failed",
    attemptCount,
    attemptedAt: nowIso,
    lastError: errorMessage,
  });

  const result = await db
    .prepare(`
      UPDATE suggestions
      SET
        delivery_status = ?,
        delivery_attempt_count = ?,
        delivery_last_error = ?,
        delivery_next_attempt_at = ?,
        updated_at = ?
      WHERE id = ?
        AND delivery_status = 'processing'
    `)
    .bind(
      scheduledDelivery.status,
      scheduledDelivery.attemptCount,
      errorMessage,
      scheduledDelivery.nextRetryAt,
      nowIso,
      suggestionId,
    )
    .run();

  if (result?.success === false || getChangedRowCount(result) !== 1) {
    throw new Error(
      `D1 could not record the failed delivery of ${suggestionId}.`,
    );
  }

  return scheduledDelivery;
}

export async function runD1SuggestionRetryCycle({
  db,
  deliverIssue,
  now = new Date(),
  limit = defaultRetryCycleLimit,
}) {
  if (!db || typeof db.prepare !== "function") {
    throw new Error("The retry service requires a D1 database binding.");
  }

  if (typeof deliverIssue !== "function") {
    throw new Error("The retry service requires a GitHub delivery function.");
  }

  const currentDate = normalizeCurrentDate(now);
  const nowIso = currentDate.toISOString();
  const safeLimit = normalizeCycleLimit(limit);
  const rows = await selectDueRetryRows(db, nowIso, safeLimit);

  const summary = {
    selected: rows.length,
    claimed: 0,
    delivered: 0,
    reused: 0,
    failed: 0,
    needsAttention: 0,
    skipped: 0,
    results: [],
  };

  for (const row of rows) {
    const claimed = await claimRetryRow(db, row, nowIso);

    if (!claimed) {
      summary.skipped += 1;
      summary.results.push({
        id: row.id,
        outcome: "skipped",
        reason: "already-claimed",
      });
      continue;
    }

    summary.claimed += 1;
    const attemptCount = row.delivery_attempt_count + 1;

    try {
      const storedRecord = parseStoredRecord(row);
      const issue = formatSuggestionAsGitHubIssue(storedRecord);
      const rawDelivery = await deliverIssue(issue, storedRecord);
      const delivery = validateGitHubDelivery(rawDelivery);

      await recordSuccessfulDelivery(
        db,
        row.id,
        attemptCount,
        delivery,
        nowIso,
      );

      summary.delivered += 1;
      if (delivery.reused) summary.reused += 1;

      summary.results.push({
        id: row.id,
        outcome: "delivered",
        attemptCount,
        ...delivery,
      });
    } catch (error) {
      const errorMessage = normalizeDeliveryError(error);

      const scheduledDelivery = await recordFailedDelivery(
        db,
        row.id,
        attemptCount,
        errorMessage,
        nowIso,
      );

      if (scheduledDelivery.status === "needs-attention") {
        summary.needsAttention += 1;
      } else {
        summary.failed += 1;
      }

      summary.results.push({
        id: row.id,
        outcome: scheduledDelivery.status,
        attemptCount,
        nextRetryAt: scheduledDelivery.nextRetryAt,
        error: errorMessage,
      });
    }
  }

  return summary;
}
