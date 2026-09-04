import assert from "node:assert/strict";

import {
  applyAutomaticRetrySchedule,
  automaticRetryDelaysMilliseconds,
  calculateNextAutomaticRetryAt,
  evaluateAutomaticRetry,
  getAutomaticRetryDelayMilliseconds,
  getDeliveryAttemptCount,
  maximumAutomaticDeliveryAttempts,
} from "./suggestion-retry-policy.mjs";

/* ========================================================================== */
/* TEST UTILITIES                                                             */
/* ========================================================================== */

const tests = [];

function registerTest(name, testFunction) {
  tests.push({
    name,
    testFunction,
  });
}

function createFailedDelivery(
  attemptCount,
  attemptedAt = "2026-08-26T12:00:00.000Z",
) {
  return {
    status: "failed",
    provider: "github",
    repository: "example-owner/architectural-geometry/architectural-geometry",
    attemptedAt,
    attemptCount,
    error: {
      message: "Temporary GitHub failure.",
    },
  };
}

function createStoredRecord(delivery) {
  return {
    recordVersion: 3,
    id: "ddef1996-a657-4e2f-998c-1f382bf5fc85",
    status: "open",
    submittedAt: "2026-08-26T11:59:00.000Z",
    suggestion: {
      title: "Retry policy test",
    },
    delivery,
  };
}

/* ========================================================================== */
/* POLICY CONFIGURATION TESTS                                                 */
/* ========================================================================== */

registerTest("Retry delay schedule", () => {
  assert.deepEqual(
    [...automaticRetryDelaysMilliseconds],
    [
      60_000,
      300_000,
      1_800_000,
      7_200_000,
    ],
  );

  assert.equal(maximumAutomaticDeliveryAttempts, 5);
});

registerTest("Delay after first failed attempt", () => {
  assert.equal(
    getAutomaticRetryDelayMilliseconds(1),
    60_000,
  );

  assert.equal(
    calculateNextAutomaticRetryAt(
      createFailedDelivery(1),
    ),
    "2026-08-26T12:01:00.000Z",
  );
});

registerTest("Delay after second failed attempt", () => {
  assert.equal(
    getAutomaticRetryDelayMilliseconds(2),
    300_000,
  );

  assert.equal(
    calculateNextAutomaticRetryAt(
      createFailedDelivery(2),
    ),
    "2026-08-26T12:05:00.000Z",
  );
});

registerTest("Delay after third failed attempt", () => {
  assert.equal(
    getAutomaticRetryDelayMilliseconds(3),
    1_800_000,
  );

  assert.equal(
    calculateNextAutomaticRetryAt(
      createFailedDelivery(3),
    ),
    "2026-08-26T12:30:00.000Z",
  );
});

registerTest("Delay after fourth failed attempt", () => {
  assert.equal(
    getAutomaticRetryDelayMilliseconds(4),
    7_200_000,
  );

  assert.equal(
    calculateNextAutomaticRetryAt(
      createFailedDelivery(4),
    ),
    "2026-08-26T14:00:00.000Z",
  );
});

/* ========================================================================== */
/* COMPATIBILITY TESTS                                                        */
/* ========================================================================== */

registerTest("Legacy failed delivery attempt inference", () => {
  const legacyDelivery = {
    status: "failed",
    provider: "github",
    attemptedAt: "2026-08-26T12:00:00.000Z",
    error: {
      message: "Historical failure.",
    },
  };

  assert.equal(getDeliveryAttemptCount(legacyDelivery), 1);

  assert.equal(
    calculateNextAutomaticRetryAt(legacyDelivery),
    "2026-08-26T12:01:00.000Z",
  );
});

registerTest("Attempt-history fallback", () => {
  const delivery = {
    status: "failed",
    attemptedAt: "2026-08-26T12:00:00.000Z",
    attempts: [
      { status: "failed" },
      { status: "failed" },
      { status: "failed" },
    ],
  };

  assert.equal(getDeliveryAttemptCount(delivery), 3);
});

/* ========================================================================== */
/* DECISION TESTS                                                             */
/* ========================================================================== */

registerTest("Retry waits before its due date", () => {
  const record = createStoredRecord(
    createFailedDelivery(1),
  );

  const decision = evaluateAutomaticRetry(
    record,
    "2026-08-26T12:00:59.999Z",
  );

  assert.equal(decision.decision, "wait");
  assert.equal(decision.reason, "retry-not-due-yet");
  assert.equal(
    decision.nextRetryAt,
    "2026-08-26T12:01:00.000Z",
  );
});

registerTest("Retry becomes due at its exact date", () => {
  const record = createStoredRecord(
    createFailedDelivery(1),
  );

  const decision = evaluateAutomaticRetry(
    record,
    "2026-08-26T12:01:00.000Z",
  );

  assert.equal(decision.decision, "retry-now");
  assert.equal(decision.reason, "retry-date-reached");
});

registerTest("Delivered suggestion is ignored", () => {
  const record = createStoredRecord({
    status: "delivered",
    provider: "github",
    attemptCount: 1,
    deliveredAt: "2026-08-26T12:00:00.000Z",
    issueNumber: 4,
    issueUrl:
      "https://github.com/example-owner/architectural-geometry/architectural-geometry/issues/4",
  });

  const decision = evaluateAutomaticRetry(
    record,
    "2026-08-27T12:00:00.000Z",
  );

  assert.equal(decision.decision, "ignore");
  assert.equal(
    decision.reason,
    "delivery-status-delivered",
  );
});

registerTest("Fifth failure requires human attention", () => {
  const failedDelivery = createFailedDelivery(5);

  assert.equal(
    getAutomaticRetryDelayMilliseconds(5),
    null,
  );

  const scheduledDelivery =
    applyAutomaticRetrySchedule(failedDelivery);

  assert.equal(
    scheduledDelivery.status,
    "needs-attention",
  );
  assert.equal(scheduledDelivery.attemptCount, 5);
  assert.equal(scheduledDelivery.nextRetryAt, null);

  const decision = evaluateAutomaticRetry(
    createStoredRecord(failedDelivery),
    "2026-08-27T12:00:00.000Z",
  );

  assert.equal(decision.decision, "needs-attention");
  assert.equal(
    decision.reason,
    "automatic-attempt-budget-exhausted",
  );
});

/* ========================================================================== */
/* SAFETY TESTS                                                               */
/* ========================================================================== */

registerTest("Policy functions do not mutate delivery records", () => {
  const originalDelivery = createFailedDelivery(2);
  const originalSnapshot = structuredClone(
    originalDelivery,
  );

  const scheduledDelivery =
    applyAutomaticRetrySchedule(originalDelivery);

  assert.deepEqual(originalDelivery, originalSnapshot);
  assert.notStrictEqual(
    scheduledDelivery,
    originalDelivery,
  );
  assert.equal(
    scheduledDelivery.nextRetryAt,
    "2026-08-26T12:05:00.000Z",
  );
});

registerTest("Invalid retry inputs are rejected", () => {
  assert.throws(
    () => getAutomaticRetryDelayMilliseconds(0),
    /positive integer/,
  );

  assert.throws(
    () =>
      calculateNextAutomaticRetryAt({
        status: "failed",
        attemptCount: 1,
        attemptedAt: "not-a-date",
      }),
    /attemptedAt date is missing or invalid/,
  );

  assert.throws(
    () =>
      applyAutomaticRetrySchedule({
        status: "delivered",
        attemptCount: 1,
      }),
    /requires delivery status "failed"/,
  );
});

/* ========================================================================== */
/* TEST EXECUTION                                                             */
/* ========================================================================== */

console.log("");
console.log("Suggestion automatic retry policy tests");
console.log("=======================================");

let passedTests = 0;

for (const test of tests) {
  try {
    await test.testFunction();
    passedTests += 1;

    console.log(`PASS - ${test.name}`);
  } catch (error) {
    console.error(`FAIL - ${test.name}`);
    console.error(`       ${error.message}`);
  }
}

console.log("");
console.log(`${passedTests}/${tests.length} tests passed.`);
console.log("");

if (passedTests !== tests.length) {
  process.exitCode = 1;
}
