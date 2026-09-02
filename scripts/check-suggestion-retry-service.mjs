import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  attemptStoredSuggestionDelivery,
  readStoredSuggestion,
  runAutomaticSuggestionRetryCycle,
  scanStoredSuggestions,
  writeSuggestionRecordAtomically,
} from "./suggestion-retry-service.mjs";

/* ========================================================================== */
/* TEST FIXTURES                                                              */
/* ========================================================================== */

const firstAttemptDate = "2026-08-26T12:00:00.000Z";

function createSuggestionRecord({
  id = "11111111-1111-4111-8111-111111111111",
  deliveryStatus = "failed",
  attemptedAt = firstAttemptDate,
  attemptCount = 1,
} = {}) {
  const attempts = [];

  for (let index = 0; index < attemptCount; index += 1) {
    attempts.push({
      status: "failed",
      attemptedAt,
      error: {
        message: `Simulated failure ${index + 1}`,
      },
    });
  }

  return {
    recordVersion: 3,
    id,
    status: "open",
    submittedAt: "2026-08-26T11:59:00.000Z",
    suggestion: {
      title: "Automatic retry service test",
      operation: "add",
      target: {
        source: {
          pageTitle: "Test page",
          sourcePath: "test/page.md",
        },
      },
      body: {
        suggestedText: "Test text",
        rationale: "Test rationale",
      },
    },
    delivery: {
      status: deliveryStatus,
      provider: "github",
      repository: "evetillard/architectural-geometry",
      attemptedAt,
      attemptCount,
      error: {
        message: "Simulated previous failure",
      },
      attempts,
    },
  };
}

function createStoredSuggestion(options = {}) {
  const record = createSuggestionRecord(options);

  return {
    filePath: path.join(
      os.tmpdir(),
      `${record.id}.json`,
    ),
    record,
  };
}

function createSilentLogger() {
  return {
    info() {},
    error() {},
  };
}

function createSuccessfulGitHubDelivery({
  issueNumber = 42,
  reused = false,
} = {}) {
  return {
    provider: "github",
    repository: "evetillard/architectural-geometry",
    issueNumber,
    issueUrl:
      `https://github.com/evetillard/architectural-geometry/issues/${issueNumber}`,
    reused,
  };
}

/* ========================================================================== */
/* TEST REGISTRY                                                              */
/* ========================================================================== */

const tests = [];

function test(name, run) {
  tests.push({ name, run });
}

/* ========================================================================== */
/* INDIVIDUAL DELIVERY TESTS                                                  */
/* ========================================================================== */

test("Successful delivery is persisted", async () => {
  const storedSuggestion = createStoredSuggestion();
  let persistedRecord = null;

  const result = await attemptStoredSuggestionDelivery(
    storedSuggestion,
    {
      clock: (() => {
        const dates = [
          new Date("2026-08-26T12:01:00.000Z"),
          new Date("2026-08-26T12:01:01.000Z"),
        ];

        return () => dates.shift();
      })(),
      formatIssue: () => ({
        title: "Formatted test Issue",
        body: "Test body",
        labels: ["content-suggestion"],
      }),
      createIssue: async () =>
        createSuccessfulGitHubDelivery(),
      writeRecord: async (_filePath, record) => {
        persistedRecord = structuredClone(record);
      },
    },
  );

  assert.equal(result.outcome, "delivered");
  assert.equal(persistedRecord.delivery.status, "delivered");
  assert.equal(persistedRecord.delivery.issueNumber, 42);
  assert.equal(persistedRecord.delivery.attemptCount, 2);
  assert.equal(persistedRecord.delivery.attempts.length, 2);
  assert.equal(persistedRecord.delivery.nextRetryAt, null);
  assert.equal(persistedRecord.recordVersion, 4);
});

test("Duplicate detector result is recorded as reused", async () => {
  const storedSuggestion = createStoredSuggestion();
  let persistedRecord = null;

  const result = await attemptStoredSuggestionDelivery(
    storedSuggestion,
    {
      clock: () => new Date("2026-08-26T12:01:00.000Z"),
      formatIssue: () => ({ title: "Test" }),
      createIssue: async () =>
        createSuccessfulGitHubDelivery({
          issueNumber: 17,
          reused: true,
        }),
      writeRecord: async (_filePath, record) => {
        persistedRecord = structuredClone(record);
      },
    },
  );

  assert.equal(result.outcome, "delivered");
  assert.equal(result.githubDelivery.reused, true);
  assert.equal(persistedRecord.delivery.reused, true);
  assert.equal(persistedRecord.delivery.issueNumber, 17);
});

test("Failed delivery receives its next retry date", async () => {
  const storedSuggestion = createStoredSuggestion();
  let persistedRecord = null;

  const result = await attemptStoredSuggestionDelivery(
    storedSuggestion,
    {
      clock: () => new Date("2026-08-26T12:01:00.000Z"),
      formatIssue: () => ({ title: "Test" }),
      createIssue: async () => {
        throw new Error("Simulated GitHub outage");
      },
      writeRecord: async (_filePath, record) => {
        persistedRecord = structuredClone(record);
      },
    },
  );

  assert.equal(result.outcome, "failed");
  assert.equal(persistedRecord.delivery.status, "failed");
  assert.equal(persistedRecord.delivery.attemptCount, 2);
  assert.equal(
    persistedRecord.delivery.nextRetryAt,
    "2026-08-26T12:06:00.000Z",
  );
  assert.equal(
    persistedRecord.delivery.error.message,
    "Simulated GitHub outage",
  );
});

test("Fifth failed attempt requires human attention", async () => {
  const storedSuggestion = createStoredSuggestion({
    attemptCount: 4,
  });
  let persistedRecord = null;

  const result = await attemptStoredSuggestionDelivery(
    storedSuggestion,
    {
      clock: () => new Date("2026-08-26T14:00:00.000Z"),
      formatIssue: () => ({ title: "Test" }),
      createIssue: async () => {
        throw new Error("Persistent simulated outage");
      },
      writeRecord: async (_filePath, record) => {
        persistedRecord = structuredClone(record);
      },
    },
  );

  assert.equal(result.outcome, "needs-attention");
  assert.equal(
    persistedRecord.delivery.status,
    "needs-attention",
  );
  assert.equal(persistedRecord.delivery.attemptCount, 5);
  assert.equal(persistedRecord.delivery.nextRetryAt, null);
});

/* ========================================================================== */
/* AUTOMATIC CYCLE TESTS                                                      */
/* ========================================================================== */

test("Cycle waits when a retry is not due", async () => {
  const storedSuggestion = createStoredSuggestion();
  const persistedRecords = [];

  const summary = await runAutomaticSuggestionRetryCycle({
    now: new Date("2026-08-26T12:00:30.000Z"),
    scan: async () => ({
      storedRecordCount: 1,
      storedSuggestions: [storedSuggestion],
      unreadableRecords: [],
    }),
    attemptDelivery: async () => {
      throw new Error("A waiting retry must not be attempted.");
    },
    writeRecord: async (_filePath, record) => {
      persistedRecords.push(structuredClone(record));
    },
    logger: createSilentLogger(),
  });

  assert.equal(summary.waiting, 1);
  assert.equal(summary.attempted, 0);
  assert.equal(persistedRecords.length, 1);
  assert.equal(
    persistedRecords[0].delivery.nextRetryAt,
    "2026-08-26T12:01:00.000Z",
  );
});

test("Cycle attempts a retry at its exact due date", async () => {
  const storedSuggestion = createStoredSuggestion();
  let attemptCount = 0;

  const summary = await runAutomaticSuggestionRetryCycle({
    now: new Date("2026-08-26T12:01:00.000Z"),
    scan: async () => ({
      storedRecordCount: 1,
      storedSuggestions: [storedSuggestion],
      unreadableRecords: [],
    }),
    attemptDelivery: async () => {
      attemptCount += 1;

      return {
        outcome: "delivered",
        githubDelivery: createSuccessfulGitHubDelivery(),
      };
    },
    logger: createSilentLogger(),
  });

  assert.equal(attemptCount, 1);
  assert.equal(summary.attempted, 1);
  assert.equal(summary.delivered, 1);
});

test("Delivered records are ignored", async () => {
  const storedSuggestion = createStoredSuggestion({
    deliveryStatus: "delivered",
  });

  const summary = await runAutomaticSuggestionRetryCycle({
    now: new Date("2026-08-26T18:00:00.000Z"),
    scan: async () => ({
      storedRecordCount: 1,
      storedSuggestions: [storedSuggestion],
      unreadableRecords: [],
    }),
    attemptDelivery: async () => {
      throw new Error("A delivered record must not be retried.");
    },
    logger: createSilentLogger(),
  });

  assert.equal(summary.ignored, 1);
  assert.equal(summary.attempted, 0);
});

test("Cycle attempt limit defers excess retries", async () => {
  const storedSuggestions = [
    createStoredSuggestion({
      id: "11111111-1111-4111-8111-111111111111",
    }),
    createStoredSuggestion({
      id: "22222222-2222-4222-8222-222222222222",
    }),
    createStoredSuggestion({
      id: "33333333-3333-4333-8333-333333333333",
    }),
  ];

  const summary = await runAutomaticSuggestionRetryCycle({
    now: new Date("2026-08-26T12:01:00.000Z"),
    maximumAttemptsPerCycle: 2,
    scan: async () => ({
      storedRecordCount: 3,
      storedSuggestions,
      unreadableRecords: [],
    }),
    attemptDelivery: async () => ({
      outcome: "delivered",
      githubDelivery: createSuccessfulGitHubDelivery(),
    }),
    logger: createSilentLogger(),
  });

  assert.equal(summary.attempted, 2);
  assert.equal(summary.delivered, 2);
  assert.equal(summary.deferredByCycleLimit, 1);
});

test("One service error does not stop the remaining records", async () => {
  const storedSuggestions = [
    createStoredSuggestion({
      id: "11111111-1111-4111-8111-111111111111",
    }),
    createStoredSuggestion({
      id: "22222222-2222-4222-8222-222222222222",
    }),
  ];

  let attemptCount = 0;

  const summary = await runAutomaticSuggestionRetryCycle({
    now: new Date("2026-08-26T12:01:00.000Z"),
    scan: async () => ({
      storedRecordCount: 2,
      storedSuggestions,
      unreadableRecords: [],
    }),
    attemptDelivery: async () => {
      attemptCount += 1;

      if (attemptCount === 1) {
        throw new Error("Simulated record-processing error");
      }

      return {
        outcome: "delivered",
        githubDelivery: createSuccessfulGitHubDelivery(),
      };
    },
    logger: createSilentLogger(),
  });

  assert.equal(attemptCount, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.delivered, 1);
  assert.equal(summary.results[0].outcome, "service-error");
});

/* ========================================================================== */
/* REAL TEMPORARY FILE-SYSTEM TESTS                                           */
/* ========================================================================== */

test("Atomic writer and reader preserve a complete record", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "suggestion-retry-service-test-"),
  );
  const filePath = path.join(temporaryDirectory, "record.json");
  const record = createSuggestionRecord();

  try {
    // Create the destination first to prove that the atomic update replaces an
    // existing record rather than requiring an empty path.
    await writeFile(filePath, "{}\n", "utf8");
    await writeSuggestionRecordAtomically(filePath, record);

    const storedSuggestion = await readStoredSuggestion(filePath);
    const rawFileContent = await readFile(filePath, "utf8");

    assert.deepEqual(storedSuggestion.record, record);
    assert.equal(rawFileContent.endsWith("\n"), true);
  } finally {
    await rm(temporaryDirectory, {
      recursive: true,
      force: true,
    });
  }
});

test("Storage scan separates valid and invalid JSON records", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "suggestion-retry-scan-test-"),
  );

  try {
    await writeFile(
      path.join(temporaryDirectory, "valid.json"),
      `${JSON.stringify(createSuggestionRecord(), null, 2)}\n`,
      "utf8",
    );

    await writeFile(
      path.join(temporaryDirectory, "invalid.json"),
      "{ this is not JSON }\n",
      "utf8",
    );

    await writeFile(
      path.join(temporaryDirectory, "ignored.txt"),
      "This file must be ignored.\n",
      "utf8",
    );

    const scanResult = await scanStoredSuggestions(
      temporaryDirectory,
    );

    assert.equal(scanResult.storedRecordCount, 2);
    assert.equal(scanResult.storedSuggestions.length, 1);
    assert.equal(scanResult.unreadableRecords.length, 1);
  } finally {
    await rm(temporaryDirectory, {
      recursive: true,
      force: true,
    });
  }
});

/* ========================================================================== */
/* TEST RUNNER                                                                */
/* ========================================================================== */

async function runTests() {
  console.log("");
  console.log("Suggestion automatic retry service tests");
  console.log("========================================");

  let passedTestCount = 0;

  for (const currentTest of tests) {
    try {
      await currentTest.run();
      passedTestCount += 1;
      console.log(`PASS - ${currentTest.name}`);
    } catch (error) {
      console.error(`FAIL - ${currentTest.name}`);
      console.error(error.stack || error.message);
    }
  }

  console.log("");
  console.log(
    `${passedTestCount}/${tests.length} tests passed.`,
  );
  console.log("");

  if (passedTestCount !== tests.length) {
    process.exitCode = 1;
  }
}

runTests().catch((error) => {
  console.error("");
  console.error("Unable to run automatic retry service tests.");
  console.error(error.stack || error.message);
  console.error("");

  process.exitCode = 1;
});
