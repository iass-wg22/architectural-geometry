import assert from "node:assert/strict";

import {
  runD1SuggestionRetryCycle,
} from "../worker/src/suggestion-retry-service.mjs";

const now = new Date("2026-09-01T12:00:00.000Z");

function createSuggestion() {
  return {
    schemaVersion: 1,
    type: "content-suggestion",
    status: "draft",
    createdAt: "2026-09-01T10:00:00.000Z",
    operation: "add",
    placement: "after",
    title: "Clarify a definition",
    target: {
      source: {
        pageTitle: "Test page",
        pageUrl: "https://example.org/test",
        sourcePath: "surfaces/test/home.md",
        pageRevision:
          "2633f0e86f493cd1067c2bfa93e6435215c2efa04bd2e03295dfad8bf9873f2a",
      },
      section: {
        title: "Definition",
        id: "definition",
        level: "h2",
      },
      selector: {
        type: "TextQuoteSelector",
        exact: "Selected passage.",
        prefix: "Before.",
        suffix: "After.",
      },
    },
    body: {
      suggestedText: "Suggested text.",
      rationale: "The definition needs clarification.",
      sources: ["Example source."],
    },
  };
}

function createRow({
  id = "11111111-1111-4111-8111-111111111111",
  nextRetryAt = "2026-09-01T11:59:00.000Z",
  attemptCount = 1,
  status = "failed",
} = {}) {
  return {
    id,
    record_version: 2,
    moderation_status: "open",
    submitted_at: "2026-09-01T10:00:00.000Z",
    suggestion_json: JSON.stringify(createSuggestion()),
    delivery_status: status,
    delivery_attempt_count: attemptCount,
    delivery_last_error: "Previous failure",
    delivery_next_attempt_at: nextRetryAt,
    github_issue_number: null,
    github_issue_url: null,
    delivered_at: null,
    updated_at: "2026-09-01T11:00:00.000Z",
  };
}

class FakeD1 {
  constructor(rows) {
    this.rows = rows.map((row) => ({ ...row }));
  }

  prepare(sql) {
    const database = this;
    const normalizedSql = sql.replace(/\s+/g, " ").trim();

    return {
      bind(...parameters) {
        return {
          async all() {
            if (!normalizedSql.startsWith("SELECT")) {
              throw new Error("Unexpected D1 all() query.");
            }

            const [dueAt, limit] = parameters;
            const results = database.rows
              .filter(
                (row) =>
                  row.delivery_status === "failed" &&
                  row.delivery_next_attempt_at !== null &&
                  row.delivery_next_attempt_at <= dueAt,
              )
              .sort((first, second) =>
                first.delivery_next_attempt_at.localeCompare(
                  second.delivery_next_attempt_at,
                ),
              )
              .slice(0, limit)
              .map((row) => ({ ...row }));

            return { success: true, results };
          },

          async run() {
            if (
              normalizedSql.includes(
                "SET delivery_status = 'processing'",
              )
            ) {
              const [updatedAt, id, expectedRetryAt, dueAt] = parameters;
              const row = database.rows.find(
                (candidate) => candidate.id === id,
              );

              const canClaim =
                row?.delivery_status === "failed" &&
                row.delivery_next_attempt_at === expectedRetryAt &&
                row.delivery_next_attempt_at <= dueAt;

              if (canClaim) {
                row.delivery_status = "processing";
                row.delivery_next_attempt_at = null;
                row.updated_at = updatedAt;
              }

              return {
                success: true,
                meta: { changes: canClaim ? 1 : 0 },
              };
            }

            if (
              normalizedSql.includes(
                "SET delivery_status = 'delivered'",
              )
            ) {
              const [
                attemptCount,
                issueNumber,
                issueUrl,
                deliveredAt,
                updatedAt,
                id,
              ] = parameters;

              const row = database.rows.find(
                (candidate) =>
                  candidate.id === id &&
                  candidate.delivery_status === "processing",
              );

              if (row) {
                row.delivery_status = "delivered";
                row.delivery_attempt_count = attemptCount;
                row.github_issue_number = issueNumber;
                row.github_issue_url = issueUrl;
                row.delivery_last_error = null;
                row.delivery_next_attempt_at = null;
                row.delivered_at = deliveredAt;
                row.updated_at = updatedAt;
              }

              return {
                success: true,
                meta: { changes: row ? 1 : 0 },
              };
            }

            if (
              normalizedSql.includes(
                "SET delivery_status = ?",
              )
            ) {
              const [
                status,
                attemptCount,
                errorMessage,
                nextRetryAt,
                updatedAt,
                id,
              ] = parameters;

              const row = database.rows.find(
                (candidate) =>
                  candidate.id === id &&
                  candidate.delivery_status === "processing",
              );

              if (row) {
                row.delivery_status = status;
                row.delivery_attempt_count = attemptCount;
                row.delivery_last_error = errorMessage;
                row.delivery_next_attempt_at = nextRetryAt;
                row.updated_at = updatedAt;
              }

              return {
                success: true,
                meta: { changes: row ? 1 : 0 },
              };
            }

            throw new Error("Unexpected D1 run() query.");
          },
        };
      },
    };
  }
}

const tests = [];

function test(name, run) {
  tests.push({ name, run });
}

test("Only due failed records are selected", async () => {
  const db = new FakeD1([
    createRow(),
    createRow({
      id: "22222222-2222-4222-8222-222222222222",
      nextRetryAt: "2026-09-01T12:01:00.000Z",
    }),
    createRow({
      id: "33333333-3333-4333-8333-333333333333",
      status: "delivered",
    }),
  ]);

  const summary = await runD1SuggestionRetryCycle({
    db,
    now,
    deliverIssue: async () => ({
      issueNumber: 21,
      issueUrl:
        "https://github.com/example-owner/architectural-geometry/architectural-geometry/issues/21",
      reused: false,
    }),
  });

  assert.equal(summary.selected, 1);
  assert.equal(summary.delivered, 1);
});

test("Successful retry is persisted", async () => {
  const db = new FakeD1([createRow()]);

  const summary = await runD1SuggestionRetryCycle({
    db,
    now,
    deliverIssue: async () => ({
      issueNumber: 22,
      issueUrl:
        "https://github.com/example-owner/architectural-geometry/architectural-geometry/issues/22",
      reused: false,
    }),
  });

  assert.equal(summary.delivered, 1);
  assert.equal(db.rows[0].delivery_status, "delivered");
  assert.equal(db.rows[0].delivery_attempt_count, 2);
  assert.equal(db.rows[0].github_issue_number, 22);
  assert.equal(db.rows[0].delivery_last_error, null);
});

test("Existing Issue reuse is a successful delivery", async () => {
  const db = new FakeD1([createRow()]);

  const summary = await runD1SuggestionRetryCycle({
    db,
    now,
    deliverIssue: async () => ({
      issueNumber: 23,
      issueUrl:
        "https://github.com/example-owner/architectural-geometry/architectural-geometry/issues/23",
      reused: true,
    }),
  });

  assert.equal(summary.delivered, 1);
  assert.equal(summary.reused, 1);
  assert.equal(db.rows[0].github_issue_number, 23);
});

test("Failed retry receives the next policy date", async () => {
  const db = new FakeD1([createRow({ attemptCount: 1 })]);

  const summary = await runD1SuggestionRetryCycle({
    db,
    now,
    deliverIssue: async () => {
      throw new Error("GitHub is unavailable.");
    },
  });

  assert.equal(summary.failed, 1);
  assert.equal(db.rows[0].delivery_status, "failed");
  assert.equal(db.rows[0].delivery_attempt_count, 2);
  assert.equal(
    db.rows[0].delivery_next_attempt_at,
    "2026-09-01T12:05:00.000Z",
  );
});

test("Fifth failure requires human attention", async () => {
  const db = new FakeD1([createRow({ attemptCount: 4 })]);

  const summary = await runD1SuggestionRetryCycle({
    db,
    now,
    deliverIssue: async () => {
      throw new Error("GitHub remains unavailable.");
    },
  });

  assert.equal(summary.needsAttention, 1);
  assert.equal(db.rows[0].delivery_status, "needs-attention");
  assert.equal(db.rows[0].delivery_attempt_count, 5);
  assert.equal(db.rows[0].delivery_next_attempt_at, null);
});

test("One delivery failure does not stop later records", async () => {
  const firstId = "11111111-1111-4111-8111-111111111111";
  const secondId = "22222222-2222-4222-8222-222222222222";
  const db = new FakeD1([
    createRow({ id: firstId }),
    createRow({ id: secondId }),
  ]);

  const summary = await runD1SuggestionRetryCycle({
    db,
    now,
    deliverIssue: async (_issue, record) => {
      if (record.id === firstId) {
        throw new Error("First delivery failed.");
      }

      return {
        issueNumber: 24,
        issueUrl:
          "https://github.com/example-owner/architectural-geometry/architectural-geometry/issues/24",
        reused: false,
      };
    },
  });

  assert.equal(summary.failed, 1);
  assert.equal(summary.delivered, 1);
  assert.equal(db.rows[1].delivery_status, "delivered");
});

console.log("");
console.log("Worker D1 retry service tests");
console.log("===============================");

let passed = 0;

for (const currentTest of tests) {
  try {
    await currentTest.run();
    passed += 1;
    console.log(`PASS - ${currentTest.name}`);
  } catch (error) {
    console.error(`FAIL - ${currentTest.name}`);
    console.error(`       ${error.message}`);
  }
}

console.log("");
console.log(`${passed}/${tests.length} tests passed.`);
console.log("");

if (passed !== tests.length) {
  process.exitCode = 1;
}
