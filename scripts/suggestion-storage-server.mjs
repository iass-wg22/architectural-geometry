// Import Node's built-in HTTP server.
//
// No web framework is required for this first local prototype: keeping the
// server small makes each request and each security decision visible.
import { createServer } from "node:http";
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Ajv validates incoming data against JSON Schema draft 2020-12.
import Ajv2020 from "ajv/dist/2020.js";

import {
  formatSuggestionAsGitHubIssue,
} from "./format-suggestion-issue.mjs";

import {
  createDevelopmentGitHubIssue,
  developmentGitHubRepository,
} from "./github-issue-client.mjs";

// Inspect failed local deliveries and retry only those whose scheduled date
// has arrived. The service owns retry history, atomic updates and the maximum
// automatic-attempt policy.
import {
  runAutomaticSuggestionRetryCycle,
} from "./suggestion-retry-service.mjs";

/* ========================================================================== */
/* SERVER CONFIGURATION                                                       */
/* ========================================================================== */

// Bind only to the current computer. The development storage server must not
// become accessible to other machines on the local network.
const serverHost = "127.0.0.1";

// A future environment variable can override the port without changing code.
const requestedPort = Number.parseInt(
  process.env.SUGGESTION_STORAGE_PORT ?? "8787",
  10,
);

if (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65535) {
  throw new Error(
    "SUGGESTION_STORAGE_PORT must be an integer between 1 and 65535.",
  );
}

const serverPort = requestedPort;

// Refuse unexpectedly large submissions before they consume excessive memory.
const maximumRequestBodyBytes = 64 * 1024;

// GitHub delivery is opt-in during local development. The ordinary storage
// command remains incapable of creating external Issues.
const commandLineArguments = process.argv.slice(2);
const unsupportedArguments = commandLineArguments.filter(
  (argument) => argument !== "--github-issues",
);

if (unsupportedArguments.length > 0) {
  throw new Error(
    `Unsupported argument(s): ${unsupportedArguments.join(", ")}`,
  );
}

const githubIssueDeliveryEnabled =
  commandLineArguments.includes("--github-issues");

// The server checks the local queue regularly. This is only the frequency at
// which the clock is inspected: the actual retry dates (1 min, 5 min, 30 min,
// 2 h) remain controlled by suggestion-retry-policy.mjs.
const retryCycleIntervalMilliseconds = Number.parseInt(
  process.env.SUGGESTION_RETRY_INTERVAL_MS ?? "15000",
  10,
);

if (
  !Number.isInteger(retryCycleIntervalMilliseconds) ||
  retryCycleIntervalMilliseconds < 1000
) {
  throw new Error(
    "SUGGESTION_RETRY_INTERVAL_MS must be an integer of at least 1000 milliseconds.",
  );
}

// Prevent a large queue from producing an uncontrolled burst of GitHub calls
// during one cycle. Remaining due suggestions stay recoverable and will be
// considered during the following cycle.
const maximumRetryAttemptsPerCycle = Number.parseInt(
  process.env.SUGGESTION_RETRY_MAX_PER_CYCLE ?? "10",
  10,
);

if (
  !Number.isInteger(maximumRetryAttemptsPerCycle) ||
  maximumRetryAttemptsPerCycle < 1 ||
  maximumRetryAttemptsPerCycle > 100
) {
  throw new Error(
    "SUGGESTION_RETRY_MAX_PER_CYCLE must be an integer between 1 and 100.",
  );
}

/* ========================================================================== */
/* PROJECT PATHS AND SCHEMA                                                   */
/* ========================================================================== */

const scriptFile = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(scriptFile);
const repositoryRoot = path.resolve(scriptDirectory, "..");
const suggestionSchemaPath = path.join(
  repositoryRoot,
  "prototype",
  "suggest-edit",
  "content-suggestion.schema.json",
);
const suggestionStorageDirectory = path.join(
  repositoryRoot,
  ".local-data",
  "suggestions",
);

const suggestionSchemaText = await readFile(suggestionSchemaPath, "utf8");
const suggestionSchema = JSON.parse(suggestionSchemaText);

const ajv = new Ajv2020({
  allErrors: true,
});

const validateSuggestion = ajv.compile(suggestionSchema);

/* ========================================================================== */
/* RESPONSE UTILITIES                                                         */
/* ========================================================================== */

function isAllowedDevelopmentOrigin(origin) {
  if (!origin) {
    return false;
  }

  // Jupyter Book generally starts on port 3000, but may select another local
  // port when it is already occupied. Only local HTTP origins are accepted.
  return /^http:\/\/(?:localhost|127\.0\.0\.1):\d+$/.test(origin);
}

function applyCorsHeaders(request, response) {
  const origin = request.headers.origin;

  if (isAllowedDevelopmentOrigin(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }

  response.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS",
  );
  response.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type",
  );
}

function sendJson(response, statusCode, payload) {
  const responseBody = `${JSON.stringify(payload, null, 2)}\n`;

  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(responseBody),
    "Cache-Control": "no-store",
  });

  response.end(responseBody);
}

class RequestError extends Error {
  constructor(statusCode, errorCode, message) {
    super(message);
    this.name = "RequestError";
    this.statusCode = statusCode;
    this.errorCode = errorCode;
  }
}

function assertJsonContentType(request) {
  const contentType = request.headers["content-type"] ?? "";
  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();

  if (mediaType !== "application/json") {
    throw new RequestError(
      415,
      "unsupported_media_type",
      "Content-Type must be application/json.",
    );
  }
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const declaredLength = Number.parseInt(
      request.headers["content-length"] ?? "0",
      10,
    );

    if (
      Number.isFinite(declaredLength) &&
      declaredLength > maximumRequestBodyBytes
    ) {
      request.resume();
      reject(
        new RequestError(
          413,
          "payload_too_large",
          `The request body must not exceed ${maximumRequestBodyBytes} bytes.`,
        ),
      );
      return;
    }

    const bodyChunks = [];
    let receivedBytes = 0;
    let bodyIsTooLarge = false;

    request.on("data", (chunk) => {
      receivedBytes += chunk.length;

      if (receivedBytes > maximumRequestBodyBytes) {
        bodyIsTooLarge = true;
        bodyChunks.length = 0;
        return;
      }

      if (!bodyIsTooLarge) {
        bodyChunks.push(chunk);
      }
    });

    request.on("end", () => {
      if (bodyIsTooLarge) {
        reject(
          new RequestError(
            413,
            "payload_too_large",
            `The request body must not exceed ${maximumRequestBodyBytes} bytes.`,
          ),
        );
        return;
      }

      resolve(Buffer.concat(bodyChunks).toString("utf8"));
    });

    request.on("error", () => {
      reject(
        new RequestError(
          400,
          "request_read_error",
          "The request body could not be read.",
        ),
      );
    });
  });
}

async function readJsonRequest(request) {
  assertJsonContentType(request);

  const requestBody = await readRequestBody(request);

  if (!requestBody.trim()) {
    throw new RequestError(
      400,
      "empty_request_body",
      "The request body must contain a JSON suggestion.",
    );
  }

  try {
    return JSON.parse(requestBody);
  } catch {
    throw new RequestError(
      400,
      "invalid_json",
      "The request body is not valid JSON.",
    );
  }
}

function formatValidationErrors(validationErrors = []) {
  return validationErrors.map((validationError) => ({
    path: validationError.instancePath || "/",
    keyword: validationError.keyword,
    message: validationError.message ?? "The value is invalid.",
  }));
}

/* ========================================================================== */
/* LOCAL PERSISTENCE                                                          */
/* ========================================================================== */

async function writeStoredRecordAtomically(
  finalFilePath,
  storedRecord,
) {
  const temporaryFilePath = path.join(
    suggestionStorageDirectory,
    `.${path.basename(finalFilePath)}.${process.pid}.${randomUUID()}.tmp`,
  );

  const serializedRecord = `${JSON.stringify(storedRecord, null, 2)}\n`;

  try {
    // "wx" refuses to overwrite an existing temporary file. The completed
    // record only becomes visible under its final name after the write and
    // atomic rename both succeed.
    await writeFile(temporaryFilePath, serializedRecord, {
      encoding: "utf8",
      flag: "wx",
    });

    await rename(temporaryFilePath, finalFilePath);
  } catch (error) {
    await rm(temporaryFilePath, {
      force: true,
    });

    throw error;
  }
}

async function persistSuggestion(suggestion) {
  // These values are assigned by the server. The browser cannot choose an ID,
  // forge the submission time or decide the moderation status.
  const suggestionId = randomUUID();
  const submittedAt = new Date().toISOString();

  const storedRecord = {
    recordVersion: 2,
    id: suggestionId,
    status: "open",
    submittedAt,
    suggestion,
    delivery: {
      status: githubIssueDeliveryEnabled
        ? "pending"
        : "not-requested",
    },
  };

  await mkdir(suggestionStorageDirectory, {
    recursive: true,
  });

  const finalFilePath = path.join(
    suggestionStorageDirectory,
    `${suggestionId}.json`,
  );
  await writeStoredRecordAtomically(
    finalFilePath,
    storedRecord,
  );

  return {
    storedRecord,
    finalFilePath,
  };
}

async function recordFailedGitHubDelivery(
  storedSuggestion,
  deliveryError,
) {
  storedSuggestion.storedRecord.delivery = {
    status: "failed",
    provider: "github",
    repository: developmentGitHubRepository,
    attemptedAt: new Date().toISOString(),
    error: {
      message: deliveryError.message,
    },
  };

  try {
    await writeStoredRecordAtomically(
      storedSuggestion.finalFilePath,
      storedSuggestion.storedRecord,
    );
  } catch (recordingError) {
    console.error(
      `[Suggestion storage] Unable to record the failed GitHub delivery for ${storedSuggestion.storedRecord.id}.`,
      recordingError,
    );
  }
}

async function deliverSuggestionToGitHub(storedSuggestion) {
  const issue = formatSuggestionAsGitHubIssue(
    storedSuggestion.storedRecord,
  );

  let githubDelivery;

  try {
    githubDelivery = await createDevelopmentGitHubIssue(issue);
  } catch (error) {
    await recordFailedGitHubDelivery(
      storedSuggestion,
      error,
    );

    return {
      succeeded: false,
      error,
    };
  }

  const delivery = {
    status: "delivered",
    ...githubDelivery,
    deliveredAt: new Date().toISOString(),
  };

  storedSuggestion.storedRecord.delivery = delivery;

  let localRecordUpdated = true;

  try {
    await writeStoredRecordAtomically(
      storedSuggestion.finalFilePath,
      storedSuggestion.storedRecord,
    );
  } catch (error) {
    // The public Issue already exists. Report delivery as successful so that
    // the browser does not retry and create a duplicate Issue.
    localRecordUpdated = false;

    console.error(
      `[Suggestion storage] GitHub Issue ${githubDelivery.issueUrl} was created, but local delivery metadata could not be updated.`,
      error,
    );
  }

  return {
    succeeded: true,
    delivery,
    localRecordUpdated,
  };
}

/* ========================================================================== */
/* AUTOMATIC RETRY SCHEDULER                                                  */
/* ========================================================================== */

let automaticRetryCycleRunning = false;
let automaticRetryIntervalHandle = null;
let serverIsStopping = false;

/**
 * Run one queue-inspection cycle without ever allowing two cycles to overlap.
 *
 * A slow or unavailable GitHub request may take longer than the configured
 * interval. In that situation the following clock tick is skipped instead of
 * starting a competing delivery attempt for the same suggestion.
 */
async function runScheduledAutomaticRetryCycle(trigger) {
  if (
    !githubIssueDeliveryEnabled ||
    serverIsStopping ||
    automaticRetryCycleRunning
  ) {
    return null;
  }

  automaticRetryCycleRunning = true;

  try {
    const summary = await runAutomaticSuggestionRetryCycle({
      now: new Date(),
      maximumAttemptsPerCycle:
        maximumRetryAttemptsPerCycle,

      // Avoid printing an empty report every fifteen seconds. Exceptional
      // per-record failures are still reported by the scheduler below.
      logger: {
        info() {},
        error() {},
      },
    });

    if (
      summary.attempted > 0 ||
      summary.needsAttention > 0 ||
      summary.unreadableRecordCount > 0
    ) {
      console.info(
        `[Suggestion retry] ${trigger} cycle: ` +
          `${summary.attempted} attempted, ` +
          `${summary.delivered} delivered, ` +
          `${summary.failed} failed, ` +
          `${summary.needsAttention} need attention, ` +
          `${summary.unreadableRecordCount} unreadable.`,
      );

      for (const result of summary.results) {
        if (result.outcome === "delivered") {
          console.info(
            `[Suggestion retry] Recovered ${result.id}: ${result.issueUrl}`,
          );
        } else {
          console.error(
            `[Suggestion retry] ${result.id}: ${result.outcome}. ${result.error ?? "No error message recorded."}`,
          );
        }
      }
    }

    return summary;
  } catch (error) {
    // A cycle failure must never stop the HTTP server. The next interval will
    // inspect the recoverable local records again.
    console.error(
      `[Suggestion retry] ${trigger} cycle failed.`,
      error,
    );

    return null;
  } finally {
    automaticRetryCycleRunning = false;
  }
}

function startAutomaticRetryScheduler() {
  if (!githubIssueDeliveryEnabled) {
    return;
  }

  // Inspect the queue immediately, so a recovered server does not have to wait
  // for the first interval before noticing overdue suggestions.
  void runScheduledAutomaticRetryCycle("startup");

  automaticRetryIntervalHandle = setInterval(() => {
    void runScheduledAutomaticRetryCycle("scheduled");
  }, retryCycleIntervalMilliseconds);
}

function stopAutomaticRetryScheduler() {
  serverIsStopping = true;

  if (automaticRetryIntervalHandle !== null) {
    clearInterval(automaticRetryIntervalHandle);
    automaticRetryIntervalHandle = null;
  }
}

/* ========================================================================== */
/* REQUEST HANDLING                                                           */
/* ========================================================================== */

const server = createServer(async (request, response) => {
  applyCorsHeaders(request, response);

  // Browsers may send this preliminary request before a cross-origin POST.
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  const requestUrl = new URL(
    request.url ?? "/",
    `http://${serverHost}:${serverPort}`,
  );

  if (request.method === "GET" && requestUrl.pathname === "/health") {
    sendJson(response, 200, {
      status: "ok",
      service: "architectural-geometry-suggestion-storage",
      storage: "local-files",
      githubDelivery: {
        enabled: githubIssueDeliveryEnabled,
        repository: githubIssueDeliveryEnabled
          ? developmentGitHubRepository
          : null,
      },
      automaticRetry: {
        enabled: githubIssueDeliveryEnabled,
        running: automaticRetryCycleRunning,
        intervalMilliseconds: githubIssueDeliveryEnabled
          ? retryCycleIntervalMilliseconds
          : null,
        maximumAttemptsPerCycle: githubIssueDeliveryEnabled
          ? maximumRetryAttemptsPerCycle
          : null,
      },
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (
    request.method === "POST" &&
    requestUrl.pathname === "/api/suggestions"
  ) {
    try {
      const suggestion = await readJsonRequest(request);
      const suggestionIsValid = validateSuggestion(suggestion);

      if (!suggestionIsValid) {
        sendJson(response, 422, {
          error: "invalid_suggestion",
          message: "The suggestion does not satisfy the content schema.",
          details: formatValidationErrors(validateSuggestion.errors),
        });
        return;
      }

      const storedSuggestion = await persistSuggestion(
        suggestion,
      );

      const responseRecord = {
        id: storedSuggestion.storedRecord.id,
        status: storedSuggestion.storedRecord.status,
        submittedAt: storedSuggestion.storedRecord.submittedAt,
        persisted: true,
      };

      console.info(
        `[Suggestion storage] Stored ${responseRecord.id}.`,
      );

      if (!githubIssueDeliveryEnabled) {
        sendJson(response, 201, {
          ...responseRecord,
          delivery: {
            status: "not-requested",
          },
          message: "The suggestion has been stored successfully.",
        });
        return;
      }

      console.info(
        `[Suggestion storage] Delivering ${responseRecord.id} to ${developmentGitHubRepository}.`,
      );

      const githubResult = await deliverSuggestionToGitHub(
        storedSuggestion,
      );

      if (!githubResult.succeeded) {
        console.error(
          `[Suggestion storage] GitHub delivery failed for ${responseRecord.id}.`,
          githubResult.error,
        );

        sendJson(response, 502, {
          ...responseRecord,
          error: "github_delivery_failed",
          delivery: {
            status: "failed",
            provider: "github",
            repository: developmentGitHubRepository,
          },
          message:
            "The suggestion was stored locally but could not be published to GitHub.",
        });
        return;
      }

      sendJson(response, 201, {
        ...responseRecord,
        delivery: githubResult.delivery,
        issueNumber: githubResult.delivery.issueNumber,
        issueUrl: githubResult.delivery.issueUrl,
        localRecordUpdated: githubResult.localRecordUpdated,
        message:
          "The suggestion has been stored and published to GitHub successfully.",
      });

      console.info(
        `[Suggestion storage] Published ${responseRecord.id} as ${githubResult.delivery.issueUrl}.`,
      );
      return;
    } catch (error) {
      if (error instanceof RequestError) {
        sendJson(response, error.statusCode, {
          error: error.errorCode,
          message: error.message,
        });
        return;
      }

      console.error("Unexpected suggestion validation error.", error);
      sendJson(response, 500, {
        error: "internal_server_error",
        message: "The suggestion could not be processed.",
      });
      return;
    }
  }

  if (requestUrl.pathname === "/api/suggestions") {
    response.setHeader("Allow", "POST, OPTIONS");
    sendJson(response, 405, {
      error: "method_not_allowed",
      message: "This endpoint only accepts POST requests.",
    });
    return;
  }

  sendJson(response, 404, {
    error: "not_found",
    message: "The requested endpoint does not exist.",
  });
});

// Handle malformed connections without crashing the process.
server.on("clientError", (_error, socket) => {
  socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

/* ========================================================================== */
/* STARTUP AND SHUTDOWN                                                       */
/* ========================================================================== */

server.listen(serverPort, serverHost, () => {
  console.log("");
  console.log("Suggestion storage server is running.");
  console.log(`Health check: http://${serverHost}:${serverPort}/health`);
  console.log(
    `Store suggestion: POST http://${serverHost}:${serverPort}/api/suggestions`,
  );
  console.log(`Storage directory: ${suggestionStorageDirectory}`);
  console.log(
    githubIssueDeliveryEnabled
      ? `GitHub delivery: ENABLED → ${developmentGitHubRepository}`
      : "GitHub delivery: disabled (local storage only)",
  );
  console.log(
    githubIssueDeliveryEnabled
      ? `Automatic retry: ENABLED → queue checked every ${retryCycleIntervalMilliseconds} ms, maximum ${maximumRetryAttemptsPerCycle} attempt(s) per cycle`
      : "Automatic retry: disabled with GitHub delivery",
  );
  console.log("Press Ctrl+C to stop the server.");
  console.log("");

  startAutomaticRetryScheduler();
});

function stopServer(signal) {
  console.log("");
  console.log(`${signal} received. Stopping suggestion storage server...`);

  stopAutomaticRetryScheduler();

  server.close((error) => {
    if (error) {
      console.error("Unable to stop the server cleanly.", error);
      process.exitCode = 1;
      return;
    }

    console.log("Suggestion storage server stopped.");
  });
}

process.on("SIGINT", () => stopServer("SIGINT"));
process.on("SIGTERM", () => stopServer("SIGTERM"));
