// Import the file-system functions used to inspect and update stored suggestions.
import {
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";

// Import utilities for creating portable paths on Windows, macOS and Linux.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import {
  createSuggestionIssueMarker,
  formatSuggestionAsGitHubIssue,
} from "./format-suggestion-issue.mjs";

import {
  createDevelopmentGitHubIssue,
  developmentGitHubRepository,
} from "./github-issue-client.mjs";

/* ========================================================================== */
/* PROJECT PATHS                                                              */
/* ========================================================================== */

// Find the directory containing this script.
const scriptFile = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(scriptFile);

// This file will live in "scripts", one level below the repository root.
const repositoryRoot = path.resolve(scriptDirectory, "..");

// Local suggestion records are deliberately excluded from Git.
const suggestionStorageDirectory = path.join(
  repositoryRoot,
  ".local-data",
  "suggestions",
);

/* ========================================================================== */
/* DISPLAY UTILITIES                                                          */
/* ========================================================================== */

function toRepositoryRelativePath(filePath) {
  return path
    .relative(repositoryRoot, filePath)
    .split(path.sep)
    .join("/");
}

function displayValue(value, fallback = "Not recorded") {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : fallback;
}

function displayDate(value) {
  if (typeof value !== "string" || !value.trim()) {
    return "Not recorded";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return `${value} (invalid date)`;
  }

  return date.toISOString();
}

function getSortableDate(value) {
  const timestamp = Date.parse(value ?? "");

  return Number.isNaN(timestamp) ? 0 : timestamp;
}

/* ========================================================================== */
/* RECORD VALIDATION                                                          */
/* ========================================================================== */

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

/**
 * Check only the fields required by the retry diagnostic.
 *
 * The complete suggestion payload is already validated by the storage server.
 * This lighter validation protects the diagnostic from incomplete, manually
 * edited or older local records.
 */
function validateStoredRecord(record) {
  const problems = [];

  if (!isPlainObject(record)) {
    return ["The JSON root must be an object."];
  }

  if (typeof record.id !== "string" || !record.id.trim()) {
    problems.push("The record ID is missing.");
  }

  if (
    typeof record.submittedAt !== "string" ||
    !record.submittedAt.trim()
  ) {
    problems.push("The submission date is missing.");
  }

  if (!isPlainObject(record.suggestion)) {
    problems.push("The suggestion payload is missing.");
  }

  if (!isPlainObject(record.delivery)) {
    problems.push("The delivery information is missing.");
  } else if (
    typeof record.delivery.status !== "string" ||
    !record.delivery.status.trim()
  ) {
    problems.push("The delivery status is missing.");
  }

  return problems;
}

/* ========================================================================== */
/* STORAGE SCAN                                                               */
/* ========================================================================== */

async function listStoredJsonFiles() {
  try {
    const directoryEntries = await readdir(suggestionStorageDirectory, {
      withFileTypes: true,
    });

    return directoryEntries
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.toLowerCase().endsWith(".json"),
      )
      .map((entry) =>
        path.join(suggestionStorageDirectory, entry.name),
      )
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function readStoredRecord(filePath) {
  const fileContent = await readFile(filePath, "utf8");

  try {
    return JSON.parse(fileContent);
  } catch (error) {
    throw new Error(`Invalid JSON: ${error.message}`);
  }
}

async function scanSuggestionStorage() {
  const storedJsonFiles = await listStoredJsonFiles();
  const validStoredSuggestions = [];
  const failedSuggestions = [];
  const unreadableRecords = [];

  for (const filePath of storedJsonFiles) {
    try {
      const record = await readStoredRecord(filePath);
      const validationProblems = validateStoredRecord(record);

      if (validationProblems.length > 0) {
        unreadableRecords.push({
          filePath,
          problems: validationProblems,
        });
        continue;
      }

      const storedSuggestion = {
        filePath,
        record,
      };

      validStoredSuggestions.push(storedSuggestion);

      if (record.delivery.status === "failed") {
        failedSuggestions.push(storedSuggestion);
      }
    } catch (error) {
      unreadableRecords.push({
        filePath,
        problems: [error.message],
      });
    }
  }

  failedSuggestions.sort(
    (left, right) =>
      getSortableDate(right.record.submittedAt) -
      getSortableDate(left.record.submittedAt),
  );

  return {
    storedRecordCount: storedJsonFiles.length,
    validStoredSuggestions,
    failedSuggestions,
    unreadableRecords,
  };
}

/* ========================================================================== */
/* REPORT                                                                     */
/* ========================================================================== */

function printFailedSuggestion(entry, index) {
  const { filePath, record } = entry;
  const suggestion = record.suggestion;
  const source = suggestion.target?.source;
  const delivery = record.delivery;

  console.log("");
  console.log(`[${index + 1}] ${displayValue(suggestion.title, "Untitled suggestion")}`);
  console.log(`    ID: ${record.id}`);
  console.log(`    Submitted: ${displayDate(record.submittedAt)}`);
  console.log(`    Operation: ${displayValue(suggestion.operation)}`);
  console.log(`    Page: ${displayValue(source?.pageTitle)}`);
  console.log(`    Source file: ${displayValue(source?.sourcePath)}`);
  console.log(`    Last attempt: ${displayDate(delivery.attemptedAt)}`);
  console.log(
    `    Error: ${displayValue(delivery.error?.message, "No error message recorded")}`,
  );
  console.log(`    Local record: ${toRepositoryRelativePath(filePath)}`);
}

function printUnreadableRecords(unreadableRecords) {
  if (unreadableRecords.length === 0) {
    return;
  }

  console.error("");
  console.error("Unreadable or incomplete records");
  console.error("--------------------------------");

  for (const entry of unreadableRecords) {
    console.error(`- ${toRepositoryRelativePath(entry.filePath)}`);

    for (const problem of entry.problems) {
      console.error(`  ${problem}`);
    }
  }
}

function printReport(scanResult) {
  const {
    storedRecordCount,
    failedSuggestions,
    unreadableRecords,
  } = scanResult;

  console.log("");
  console.log("Failed suggestion delivery diagnostic");
  console.log("=====================================");
  console.log(
    `Storage: ${toRepositoryRelativePath(suggestionStorageDirectory)}`,
  );
  console.log(`Stored JSON record(s): ${storedRecordCount}`);
  console.log(`Failed delivery record(s): ${failedSuggestions.length}`);

  if (failedSuggestions.length === 0) {
    console.log("");
    console.log("No failed GitHub deliveries were found.");
  } else {
    console.log("");
    console.log(
      "The following suggestions are stored locally and remain recoverable:",
    );

    failedSuggestions.forEach(printFailedSuggestion);

    console.log("");
    console.log("READ-ONLY DIAGNOSTIC: no record was modified.");
    console.log("No GitHub request was made.");
  }

  printUnreadableRecords(unreadableRecords);

  if (unreadableRecords.length > 0) {
    process.exitCode = 1;
  }
}

/* ========================================================================== */
/* RETRY PREPARATION                                                          */
/* ========================================================================== */

function findStoredSuggestionById(scanResult, requestedId) {
  // This validates and normalizes the identifier without making a GitHub
  // request. The marker itself will later be used by the duplicate detector.
  createSuggestionIssueMarker(requestedId);

  const normalizedRequestedId = requestedId.toLowerCase();

  const matches = scanResult.validStoredSuggestions.filter(
    ({ record }) =>
      record.id.toLowerCase() === normalizedRequestedId,
  );

  if (matches.length === 0) {
    throw new Error(
      `No stored suggestion was found with ID ${requestedId}.`,
    );
  }

  if (matches.length > 1) {
    throw new Error(
      `Multiple local records use suggestion ID ${requestedId}. Retry refused.`,
    );
  }

  return matches[0];
}

function ensureRetryIsAllowed(storedSuggestion) {
  const deliveryStatus = storedSuggestion.record.delivery.status;

  if (deliveryStatus === "delivered") {
    throw new Error(
      `Suggestion ${storedSuggestion.record.id} is already delivered. Retry refused.`,
    );
  }

  if (deliveryStatus !== "failed") {
    throw new Error(
      `Suggestion ${storedSuggestion.record.id} has delivery status "${deliveryStatus}" instead of "failed". Retry refused.`,
    );
  }
}

function printRetryPreview(storedSuggestion, issue) {
  const { filePath, record } = storedSuggestion;

  console.log("");
  console.log("Failed suggestion retry preview");
  console.log("===============================");
  console.log(`ID: ${record.id}`);
  console.log(`Title: ${issue.title}`);
  console.log(`Repository: ${developmentGitHubRepository}`);
  console.log(
    `Previous attempt: ${displayDate(record.delivery.attemptedAt)}`,
  );
  console.log(
    `Previous error: ${displayValue(record.delivery.error?.message)}`,
  );
  console.log(`Local record: ${toRepositoryRelativePath(filePath)}`);
  console.log("");
  console.log("DRY RUN: no local record was modified.");
  console.log("No GitHub request was made.");
  console.log("");
  console.log("Confirm this exact retry with:");
  console.log(
    `  npm run retry:suggestions -- --id "${record.id}" --confirm`,
  );
  console.log("");
}

/* ========================================================================== */
/* ATOMIC LOCAL UPDATE                                                        */
/* ========================================================================== */

async function writeStoredRecordAtomically(filePath, storedRecord) {
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
    await rm(temporaryFilePath, {
      force: true,
    });

    throw error;
  }
}

/* ========================================================================== */
/* DELIVERY HISTORY                                                          */
/* ========================================================================== */

function copyRecordedAttempts(delivery, submittedAt) {
  if (Array.isArray(delivery.attempts)) {
    return delivery.attempts
      .filter(isPlainObject)
      .map((attempt) => structuredClone(attempt));
  }

  // Records written before retry support contain only the most recent failed
  // delivery. Convert that information into the first history entry.
  if (delivery.status === "failed") {
    return [
      {
        status: "failed",
        attemptedAt:
          displayDate(delivery.attemptedAt) === "Not recorded"
            ? submittedAt
            : delivery.attemptedAt,
        error: {
          message: displayValue(
            delivery.error?.message,
            "No error message recorded",
          ),
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

  attempts.push({
    status: "failed",
    attemptedAt,
    error: {
      message: error.message,
    },
  });

  return {
    status: "failed",
    provider: "github",
    repository: developmentGitHubRepository,
    attemptedAt,
    attemptCount: attempts.length,
    error: {
      message: error.message,
    },
    attempts,
  };
}

function createSuccessfulDelivery(
  previousDelivery,
  submittedAt,
  attemptedAt,
  githubDelivery,
) {
  const deliveredAt = new Date().toISOString();
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
    attempts,
  };
}

/* ========================================================================== */
/* CONFIRMED RETRY                                                           */
/* ========================================================================== */

async function retryFailedSuggestion(storedSuggestion) {
  ensureRetryIsAllowed(storedSuggestion);

  const { filePath, record } = storedSuggestion;
  const issue = formatSuggestionAsGitHubIssue(record);
  const previousDelivery = structuredClone(record.delivery);
  const attemptedAt = new Date().toISOString();

  console.log("");
  console.log(`Retrying suggestion ${record.id}...`);
  console.log(
    "Checking GitHub for an existing Issue before creating anything...",
  );

  let githubDelivery;

  try {
    githubDelivery = await createDevelopmentGitHubIssue(issue);
  } catch (error) {
    const failedDelivery = createFailedDelivery(
      previousDelivery,
      record.submittedAt,
      attemptedAt,
      error,
    );

    const failedRecord = {
      ...record,
      recordVersion: Math.max(record.recordVersion ?? 0, 3),
      delivery: failedDelivery,
    };

    try {
      await writeStoredRecordAtomically(filePath, failedRecord);
    } catch (storageError) {
      throw new Error(
        `GitHub retry failed, and its new failure metadata could not be recorded: ${storageError.message}. ` +
          `The original local record remains at ${toRepositoryRelativePath(filePath)}. ` +
          `GitHub error: ${error.message}`,
      );
    }

    throw new Error(
      `GitHub retry failed. The suggestion remains stored locally with delivery status "failed". ${error.message}`,
    );
  }

  const successfulDelivery = createSuccessfulDelivery(
    previousDelivery,
    record.submittedAt,
    attemptedAt,
    githubDelivery,
  );

  const deliveredRecord = {
    ...record,
    recordVersion: Math.max(record.recordVersion ?? 0, 3),
    delivery: successfulDelivery,
  };

  try {
    await writeStoredRecordAtomically(filePath, deliveredRecord);
  } catch (storageError) {
    throw new Error(
      `GitHub Issue ${githubDelivery.issueUrl} exists, but the local delivery record could not be updated: ${storageError.message}. ` +
        "Run the same retry command again; the duplicate detector will reuse the existing Issue.",
    );
  }

  console.log("");
  console.log("Suggestion delivery recovered successfully.");
  console.log(`Issue: ${githubDelivery.issueUrl}`);
  console.log(
    githubDelivery.reused
      ? "Existing Issue reused: yes"
      : "Existing Issue reused: no (a new Issue was created)",
  );
  console.log(`Attempt count: ${successfulDelivery.attemptCount}`);
  console.log(`Local record updated: ${toRepositoryRelativePath(filePath)}`);
  console.log("");

  return deliveredRecord;
}

/* ========================================================================== */
/* COMMAND-LINE INTERFACE                                                     */
/* ========================================================================== */

function parseCommandLineArguments(argumentsList) {
  let requestedId = null;
  let confirm = false;

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];

    if (argument === "--id") {
      if (requestedId !== null) {
        throw new Error("The --id option may only be used once.");
      }

      const idValue = argumentsList[index + 1];

      if (!idValue || idValue.startsWith("--")) {
        throw new Error("The --id option requires a suggestion UUID.");
      }

      requestedId = idValue.trim().toLowerCase();
      createSuggestionIssueMarker(requestedId);
      index += 1;
      continue;
    }

    if (argument === "--confirm") {
      if (confirm) {
        throw new Error("The --confirm option may only be used once.");
      }

      confirm = true;
      continue;
    }

    throw new Error(`Unsupported argument: ${argument}`);
  }

  if (confirm && requestedId === null) {
    throw new Error(
      "The --confirm option requires an explicit --id value.",
    );
  }

  return {
    requestedId,
    confirm,
  };
}

async function main() {
  const commandLineOptions = parseCommandLineArguments(
    process.argv.slice(2),
  );

  const scanResult = await scanSuggestionStorage();

  if (commandLineOptions.requestedId === null) {
    printReport(scanResult);
    return;
  }

  const storedSuggestion = findStoredSuggestionById(
    scanResult,
    commandLineOptions.requestedId,
  );

  ensureRetryIsAllowed(storedSuggestion);

  const issue = formatSuggestionAsGitHubIssue(
    storedSuggestion.record,
  );

  if (!commandLineOptions.confirm) {
    printRetryPreview(storedSuggestion, issue);
    return;
  }

  await retryFailedSuggestion(storedSuggestion);
}

const isDirectExecution =
  process.argv[1] &&
  path.resolve(process.argv[1]) === scriptFile;

if (isDirectExecution) {
  main().catch((error) => {
    console.error("");
    console.error("Unable to process failed suggestion deliveries.");
    console.error(error.message);
    console.error("");

    process.exitCode = 1;
  });
}

export {
  parseCommandLineArguments,
  retryFailedSuggestion,
  scanSuggestionStorage,
};
