import assert from "node:assert/strict";

import {
  createSuggestionIssueMarker,
} from "../lib/content-suggestions/github-issue-formatter.mjs";

import {
  findExistingGitHubIssueBySuggestionId,
} from "../lib/content-suggestions/github-issue-duplicates.mjs";

const repository = "example-owner/architectural-geometry/architectural-geometry";
const suggestionId = "11111111-1111-4111-8111-111111111111";
const marker = createSuggestionIssueMarker(suggestionId);

const tests = [];

function test(name, run) {
  tests.push({ name, run });
}

function issue(number, body, extra = {}) {
  return {
    number,
    html_url: `https://github.com/${repository}/issues/${number}`,
    body,
    ...extra,
  };
}

test("No matching Issue requests creation", () => {
  const result = findExistingGitHubIssueBySuggestionId({
    suggestionId,
    repository,
    repositoryItems: [issue(10, "Another suggestion")],
  });

  assert.equal(result, null);
});

test("Open matching Issue is reused", () => {
  const result = findExistingGitHubIssueBySuggestionId({
    suggestionId,
    repository,
    repositoryItems: [issue(11, `Body\n\n${marker}`, { state: "open" })],
  });

  assert.equal(result.issueNumber, 11);
  assert.equal(result.reused, true);
});

test("Closed matching Issue is reused", () => {
  const result = findExistingGitHubIssueBySuggestionId({
    suggestionId,
    repository,
    repositoryItems: [issue(12, marker, { state: "closed" })],
  });

  assert.equal(result.issueNumber, 12);
  assert.equal(result.reused, true);
});

test("Pull Request carrying the marker is ignored", () => {
  const result = findExistingGitHubIssueBySuggestionId({
    suggestionId,
    repository,
    repositoryItems: [
      issue(13, marker, {
        pull_request: {
          url: "https://api.github.com/example/pulls/13",
        },
      }),
    ],
  });

  assert.equal(result, null);
});

test("Multiple matching Issues are rejected", () => {
  assert.throws(
    () =>
      findExistingGitHubIssueBySuggestionId({
        suggestionId,
        repository,
        repositoryItems: [issue(14, marker), issue(15, marker)],
      }),
    /Multiple GitHub Issues/,
  );
});

console.log("");
console.log("GitHub Issue duplicate detection tests");
console.log("======================================");

let passed = 0;

for (const currentTest of tests) {
  try {
    currentTest.run();
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
