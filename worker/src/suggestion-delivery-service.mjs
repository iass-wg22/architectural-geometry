import {
  applyAutomaticRetrySchedule,
} from "../../lib/content-suggestions/suggestion-retry-policy.mjs";

import {
  formatSuggestionAsGitHubIssue,
} from "../../lib/content-suggestions/github-issue-formatter.mjs";

function changedRows(result) {
  return result?.meta?.changes ?? result?.changes ?? 0;
}

function normalizeError(error) {
  const message = error instanceof Error
    ? error.message
    : String(error ?? "Unknown GitHub delivery error.");

  return message.trim().slice(0, 2000) || "Unknown GitHub delivery error.";
}

async function claimPendingSuggestion(db, id, nowIso) {
  const result = await db.prepare(`
    UPDATE suggestions
    SET delivery_status = 'processing', updated_at = ?
    WHERE id = ? AND delivery_status = 'pending'
  `).bind(nowIso, id).run();

  if (result?.success === false) {
    throw new Error(`D1 could not claim pending suggestion ${id}.`);
  }

  return changedRows(result) === 1;
}

async function recordSuccess(db, id, delivery, nowIso) {
  const result = await db.prepare(`
    UPDATE suggestions
    SET
      delivery_status = 'delivered',
      delivery_attempt_count = 1,
      github_issue_number = ?,
      github_issue_url = ?,
      delivery_last_error = NULL,
      delivery_next_attempt_at = NULL,
      delivered_at = ?,
      updated_at = ?
    WHERE id = ? AND delivery_status = 'processing'
  `).bind(
    delivery.issueNumber,
    delivery.issueUrl,
    nowIso,
    nowIso,
    id,
  ).run();

  if (result?.success === false || changedRows(result) !== 1) {
    throw new Error(`D1 could not record the delivery of ${id}.`);
  }
}

async function recordFailure(db, id, errorMessage, nowIso) {
  const scheduled = applyAutomaticRetrySchedule({
    status: "failed",
    attemptCount: 1,
    attemptedAt: nowIso,
    lastError: errorMessage,
  });

  const result = await db.prepare(`
    UPDATE suggestions
    SET
      delivery_status = ?,
      delivery_attempt_count = 1,
      delivery_last_error = ?,
      delivery_next_attempt_at = ?,
      updated_at = ?
    WHERE id = ? AND delivery_status = 'processing'
  `).bind(
    scheduled.status,
    errorMessage,
    scheduled.nextRetryAt,
    nowIso,
    id,
  ).run();

  if (result?.success === false || changedRows(result) !== 1) {
    throw new Error(`D1 could not record the failed delivery of ${id}.`);
  }

  return scheduled;
}

function validateDelivery(delivery) {
  if (!Number.isInteger(delivery?.issueNumber) || delivery.issueNumber < 1) {
    throw new Error("GitHub delivery returned no valid Issue number.");
  }

  if (
    typeof delivery.issueUrl !== "string" ||
    !/^https:\/\/github\.com\/.+\/issues\/\d+\/?$/iu.test(delivery.issueUrl)
  ) {
    throw new Error("GitHub delivery returned no valid Issue URL.");
  }

  return delivery;
}

export async function deliverPendingSuggestion({
  db,
  storedRecord,
  deliverIssue,
  now = new Date(),
}) {
  if (!db || typeof db.prepare !== "function") {
    throw new Error("Pending delivery requires a D1 database binding.");
  }

  if (!storedRecord?.id || typeof deliverIssue !== "function") {
    throw new Error("Pending delivery configuration is incomplete.");
  }

  const nowIso = new Date(now).toISOString();
  const claimed = await claimPendingSuggestion(db, storedRecord.id, nowIso);

  if (!claimed) {
    return { status: "skipped", reason: "not-pending" };
  }

  try {
    const issue = formatSuggestionAsGitHubIssue(storedRecord);
    const delivery = validateDelivery(await deliverIssue(issue, storedRecord));

    await recordSuccess(db, storedRecord.id, delivery, nowIso);

    return {
      status: "delivered",
      attemptCount: 1,
      issueNumber: delivery.issueNumber,
      issueUrl: delivery.issueUrl,
      reused: delivery.reused === true,
    };
  } catch (error) {
    const errorMessage = normalizeError(error);
    const scheduled = await recordFailure(
      db,
      storedRecord.id,
      errorMessage,
      nowIso,
    );

    return {
      status: scheduled.status,
      attemptCount: 1,
      nextRetryAt: scheduled.nextRetryAt,
      error: errorMessage,
    };
  }
}
