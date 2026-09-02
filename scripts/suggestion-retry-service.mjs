// Import the file-system operations required to inspect and update the local
// suggestion records.
import {
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";

// Import path and URL utilities so this module behaves identically on
// Windows, macOS and Linux.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

// Convert one stored suggestion into the public GitHub Issue format.
import {
  formatSuggestionAsGitHubIssue,
} from "./format-suggestion-issue.mjs";

// Deliver the formatted Issue. The client already contains the duplicate
// detector, so retrying the same suggestion cannot intentionally create a
// second Issue.
import {
  createDevelopmentGitHubIssue,
  developmentGitHubRepository,
} from "./github-issue-client.mjs";

// Keep scheduling decisions in a small, deterministic and separately tested
// policy module.
import {
  applyAutomaticRetrySchedule,
  evaluateAutomaticRetry,
} from "./suggestion-retry-policy.mjs";

/* ========================================================================== */
/* PROJECT PATHS                                                              */
/* ========================================================================== */

const scriptFile = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(scriptFile);
const repositoryRoot = path.resolve(scriptDirectory, "..");

export const defaultSuggestionStorageDirectory = path.join(
  repositoryRoot,
  ".local-data",
  "suggestions",
);

/* ========================================================================== */
/* GENERIC UTILITIES                                                          */
/* ========================================================================== */

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function normalizeDate(value, fieldName) {
  const date = value instanceof Date
    ? new Date(value.getTime())
    : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`The ${fieldName} is not a valid date.`);
  }

  return date;
}

function getClockDate(clock) {
  if (typeof clock !== "function") {
    throw new Error("The retry service clock must be a function.");
  }

  return normalizeDate(clock(), "retry service clock value");
}

function toRepositoryRelativePath(filePath) {
  return path
    .relative(repositoryRoot, filePath)
    .split(path.sep)
    .join("/");
}

function recordsAreEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function createServiceError(error) {
  return {
    name:
      typeof error?.name === "string" && error.name
        ? error.name
        : "Error",
    message:
      typeof error?.message === "string" && error.message
        ? error.message
        : String(error),
  };
}

function validateStoredSuggestion(storedSuggestion) {
  if (!isPlainObject(storedSuggestion)) {
    throw new Error(
      "The retry service requires a stored suggestion entry.",
    );
  }

  if (
    typeof storedSuggestion.filePath !== "string" ||
    !storedSuggestion.filePath.trim()
  ) {
    throw new Error(
      "The stored suggestion file path is missing.",
    );
  }

  const record = storedSuggestion.record;

  if (!isPlainObject(record)) {
    throw new Error("The stored suggestion record is missing.");
  }

  if (typeof record.id !== "string" || !record.id.trim()) {
    throw new Error("The stored suggestion record ID is missing.");
  }

  if (!isPlainObject(record.suggestion)) {
    throw new Error("The stored suggestion payload is missing.");
  }

  return {
    filePath: storedSuggestion.filePath,
    record,
  };
}

/* ========================================================================== */
/* STORAGE                                                                    */
/* ========================================================================== */

export async function writeSuggestionRecordAtomically(
  filePath,
  storedRecord,
) {
  const temporaryFilePath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );

  const serializedRecord =
    `${JSON.stringify(storedRecord, null, 2)}\n`;

  try {
    await writeFile(temporaryFilePath, serializedRecord, {
      encoding: "utf8",
      flag: "wx",
    });

    await rename(temporaryFilePath, filePath);
  } catch (error) {
    await rm(temporaryFilePath, { force: true });
    throw error;
  }
}

export async function readStoredSuggestion(filePath) {
  const fileContent = await readFile(filePath, "utf8");
  let record;

  try {
    record = JSON.parse(fileContent);
  } catch (error) {
    throw new Error(
      `Invalid JSON in ${toRepositoryRelativePath(filePath)}: ${error.message}`,
    );
  }

  return validateStoredSuggestion({ filePath, record });
}

export async function scanStoredSuggestions(
  storageDirectory = defaultSuggestionStorageDirectory,
) {
  let directoryEntries;

  try {
    directoryEntries = await readdir(storageDirectory, {
      withFileTypes: true,
    });
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        storedRecordCount: 0,
        storedSuggestions: [],
        unreadableRecords: [],
      };
    }

    throw error;
  }

  const jsonFilePaths = directoryEntries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.toLowerCase().endsWith(".json"),
    )
    .map((entry) => path.join(storageDirectory, entry.name))
    .sort((left, right) => left.localeCompare(right));

  const storedSuggestions = [];
  const unreadableRecords = [];

  for (const filePath of jsonFilePaths) {
    try {
      storedSuggestions.push(
        await readStoredSuggestion(filePath),
      );
    } catch (error) {
      unreadableRecords.push({
        filePath,
        error: createServiceError(error),
      });
    }
  }

  return {
    storedRecordCount: jsonFilePaths.length,
    storedSuggestions,
    unreadableRecords,
  };
}

/* ========================================================================== */
/* DELIVERY HISTORY                                                          */
/* ========================================================================== */

function copyRecordedAttempts(delivery, submittedAt) {
  if (Array.isArray(delivery?.attempts)) {
    return delivery.attempts
      .filter(isPlainObject)
      .map((attempt) => structuredClone(attempt));
  }

  // Older records stored only the most recent attempt. Preserve it as the
  // first history entry when the new retry engine encounters such a record.
  if (delivery?.status === "failed") {
    return [
      {
        status: "failed",
        attemptedAt:
          typeof delivery.attemptedAt === "string" &&
          delivery.attemptedAt.trim()
            ? delivery.attemptedAt
            : submittedAt,
        error: {
          message:
            typeof delivery.error?.message === "string" &&
            delivery.error.message.trim()
              ? delivery.error.message
              : "No error message recorded",
        },
      },
    ];
  }

  return [];
}

function createFailedDelivery(
  previousDelivery,
  submittedAt,
  attemptedAt,
  error,
) {
  const attempts = copyRecordedAttempts(
    previousDelivery,
    submittedAt,
  );

  const serviceError = createServiceError(error);

  attempts.push({
    status: "failed",
    attemptedAt,
    error: serviceError,
  });

  return applyAutomaticRetrySchedule({
    status: "failed",
    provider: "github",
    repository: developmentGitHubRepository,
    attemptedAt,
    attemptCount: attempts.length,
    error: serviceError,
    attempts,
  });
}

function createSuccessfulDelivery(
  previousDelivery,
  submittedAt,
  attemptedAt,
  githubDelivery,
  deliveredAt,
) {
  const attempts = copyRecordedAttempts(
    previousDelivery,
    submittedAt,
  );

  attempts.push({
    status: "delivered",
    attemptedAt,
    deliveredAt,
    issueNumber: githubDelivery.issueNumber,
    issueUrl: githubDelivery.issueUrl,
    reused: githubDelivery.reused === true,
  });

  return {
    status: "delivered",
    provider: "github",
    repository: githubDelivery.repository,
    issueNumber: githubDelivery.issueNumber,
    issueUrl: githubDelivery.issueUrl,
    deliveredAt,
    attemptCount: attempts.length,
    reused: githubDelivery.reused === true,
    nextRetryAt: null,
    attempts,
  };
}

/* ========================================================================== */
/* ONE DELIVERY ATTEMPT                                                       */
/* ========================================================================== */

/**
 * Attempt to deliver one stored suggestion and persist the result.
 *
 * Dependencies are injectable so automated tests can simulate GitHub success
 * and failure without performing a real network request.
 */
export async function attemptStoredSuggestionDelivery(
  storedSuggestion,
  {
    clock = () => new Date(),
    formatIssue = formatSuggestionAsGitHubIssue,
    createIssue = createDevelopmentGitHubIssue,
    writeRecord = writeSuggestionRecordAtomically,
  } = {},
) {
  const { filePath, record } =
    validateStoredSuggestion(storedSuggestion);

  const previousDelivery = isPlainObject(record.delivery)
    ? structuredClone(record.delivery)
    : {};

  const attemptedAt = getClockDate(clock).toISOString();
  const issue = formatIssue(record);

  let githubDelivery;

  try {
    githubDelivery = await createIssue(issue);
  } catch (error) {
    const failedDelivery = createFailedDelivery(
      previousDelivery,
      record.submittedAt,
      attemptedAt,
      error,
    );

    const failedRecord = {
      ...record,
      recordVersion: Math.max(record.recordVersion ?? 0, 4),
      delivery: failedDelivery,
    };

    await writeRecord(filePath, failedRecord);

    return {
      outcome:
        failedDelivery.status === "needs-attention"
          ? "needs-attention"
          : "failed",
      record: failedRecord,
      error: createServiceError(error),
    };
  }

  const deliveredAt = getClockDate(clock).toISOString();
  const successfulDelivery = createSuccessfulDelivery(
    previousDelivery,
    record.submittedAt,
    attemptedAt,
    githubDelivery,
    deliveredAt,
  );

  const deliveredRecord = {
    ...record,
    recordVersion: Math.max(record.recordVersion ?? 0, 4),
    delivery: successfulDelivery,
  };

  await writeRecord(filePath, deliveredRecord);

  return {
    outcome: "delivered",
    record: deliveredRecord,
    githubDelivery,
  };
}

/* ========================================================================== */
/* SCHEDULE PERSISTENCE                                                       */
/* ========================================================================== */

async function persistRetryDecision(
  storedSuggestion,
  decision,
  writeRecord,
) {
  if (
    decision.decision !== "wait" &&
    decision.decision !== "needs-attention"
  ) {
    return storedSuggestion.record;
  }

  const scheduledDelivery = applyAutomaticRetrySchedule(
    storedSuggestion.record.delivery,
  );

  const scheduledRecord = {
    ...storedSuggestion.record,
    recordVersion: Math.max(
      storedSuggestion.record.recordVersion ?? 0,
      4,
    ),
    delivery: scheduledDelivery,
  };

  if (!recordsAreEqual(storedSuggestion.record, scheduledRecord)) {
    await writeRecord(
      storedSuggestion.filePath,
      scheduledRecord,
    );
  }

  return scheduledRecord;
}

/* ========================================================================== */
/* ONE AUTOMATIC RETRY CYCLE                                                  */
/* ========================================================================== */

/**
 * Inspect every stored suggestion once and process only due retries.
 *
 * This function contains no timer. The local server will later call it on a
 * regular interval. Keeping scheduling and timing separate makes the engine
 * deterministic, testable and safe to run manually.
 */
export async function runAutomaticSuggestionRetryCycle({
  now = new Date(),
  maximumAttemptsPerCycle = 10,
  scan = scanStoredSuggestions,
  attemptDelivery = attemptStoredSuggestionDelivery,
  writeRecord = writeSuggestionRecordAtomically,
  logger = console,
} = {}) {
  const cycleDate = normalizeDate(now, "automatic retry cycle date");

  if (
    !Number.isInteger(maximumAttemptsPerCycle) ||
    maximumAttemptsPerCycle < 1
  ) {
    throw new Error(
      "maximumAttemptsPerCycle must be a positive integer.",
    );
  }

  const scanResult = await scan();
  const summary = {
    startedAt: cycleDate.toISOString(),
    storedRecordCount: scanResult.storedRecordCount,
    unreadableRecordCount: scanResult.unreadableRecords.length,
    ignored: 0,
    waiting: 0,
    attempted: 0,
    delivered: 0,
    failed: 0,
    needsAttention: 0,
    deferredByCycleLimit: 0,
    results: [],
  };

  for (const storedSuggestion of scanResult.storedSuggestions) {
    const decision = evaluateAutomaticRetry(
      storedSuggestion.record,
      cycleDate,
    );

    if (decision.decision === "ignore") {
      summary.ignored += 1;
      continue;
    }

    if (decision.decision === "wait") {
      await persistRetryDecision(
        storedSuggestion,
        decision,
        writeRecord,
      );
      summary.waiting += 1;
      continue;
    }

    if (decision.decision === "needs-attention") {
      await persistRetryDecision(
        storedSuggestion,
        decision,
        writeRecord,
      );
      summary.needsAttention += 1;
      continue;
    }

    if (summary.attempted >= maximumAttemptsPerCycle) {
      summary.deferredByCycleLimit += 1;
      continue;
    }

    summary.attempted += 1;

    let result;

    try {
      result = await attemptDelivery(storedSuggestion);
    } catch (error) {
      const serviceError = createServiceError(error);

      summary.failed += 1;
      summary.results.push({
        id: storedSuggestion.record.id,
        outcome: "service-error",
        issueUrl: null,
        error: serviceError.message,
      });

      logger?.error?.(
        `[Suggestion retry] Unable to process ${storedSuggestion.record.id}: ${serviceError.message}`,
      );

      continue;
    }

    summary.results.push({
      id: storedSuggestion.record.id,
      outcome: result.outcome,
      issueUrl: result.githubDelivery?.issueUrl ?? null,
      error: result.error?.message ?? null,
    });

    if (result.outcome === "delivered") {
      summary.delivered += 1;
    } else if (result.outcome === "needs-attention") {
      summary.needsAttention += 1;
    } else {
      summary.failed += 1;
    }
  }

  summary.finishedAt = new Date().toISOString();

  logger?.info?.(
    `[Suggestion retry] ${summary.attempted} attempt(s): ` +
      `${summary.delivered} delivered, ${summary.failed} failed, ` +
      `${summary.needsAttention} need attention.`,
  );

  return summary;
}
