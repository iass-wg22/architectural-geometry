import assert from "node:assert/strict";

import {
  formatSuggestionAsGitHubIssue,
} from "./format-suggestion-issue.mjs";

/* ========================================================================== */
/* SHARED TEST DATA                                                           */
/* ========================================================================== */

function createBaseSuggestion() {
  return {
    title: "Clarify the definition of prestress",
    operation: "add",
    placement: "after",
    target: {
      source: {
        pageTitle: "Self-Prestressed",
        pageUrl:
          "https://example.org/portals/form-force/pre-stressed/home",
        sourcePath:
          "portals/form_force/pre_stressed/home.md",
        pageRevision:
          "2633f0e86f493cd1067c2bfa93e6435215c2efa04bd2e03295dfad8bf9873f2a",
      },
      section: {
        title: "Definition¶",
        id: "definition",
        level: "h2",
      },
      selector: {
        type: "TextQuoteSelector",
        exact: "Prestress must be introduced during construction.",
        prefix: "The structure is initially unstressed.",
        suffix: "It is then transferred to the boundary supports.",
      },
    },
    body: {
      suggestedText:
        "Prestress is introduced before the service loads are applied.",
      rationale:
        "This clarification distinguishes prestress from external loading.",
      sources: [
        "Example reference, 2026.",
      ],
    },
    contributor: {
      displayName: "Ada Example",
      affiliation: "Example Research Institute",
    },
  };
}

/* ========================================================================== */
/* TEST RUNNER                                                                */
/* ========================================================================== */

const tests = [];

function registerTest(name, testFunction) {
  tests.push({
    name,
    testFunction,
  });
}

registerTest("Addition", () => {
  const suggestion = createBaseSuggestion();
  const issue = formatSuggestionAsGitHubIssue(suggestion);

  assert.equal(
    issue.title,
    "[Content suggestion] Clarify the definition of prestress",
  );

  assert.ok(
    issue.labels.includes("operation:add"),
    "The addition label is missing.",
  );

  assert.match(
    issue.body,
    /\*\*Operation:\*\* Addition/,
  );

  assert.match(
    issue.body,
    /Add text after the selected passage/,
  );

  assert.match(
    issue.body,
    /### Suggested text/,
  );

  assert.match(
    issue.body,
    /Prestress is introduced before the service loads are applied\./,
  );

  assert.match(
    issue.body,
    /Ada Example — Example Research Institute/,
  );

  assert.doesNotMatch(
    issue.body,
    /Definition¶/,
  );
});

registerTest("Deletion", () => {
  const suggestion = createBaseSuggestion();

  suggestion.title = "Remove an inaccurate statement";
  suggestion.operation = "delete";
  delete suggestion.placement;
  delete suggestion.body.suggestedText;

  const issue = formatSuggestionAsGitHubIssue(suggestion);

  assert.ok(
    issue.labels.includes("operation:delete"),
    "The deletion label is missing.",
  );

  assert.match(
    issue.body,
    /\*\*Operation:\*\* Deletion/,
  );

  assert.match(
    issue.body,
    /Delete the selected passage/,
  );

  assert.doesNotMatch(
    issue.body,
    /### Suggested text/,
    "A deletion must not contain a suggested-text section.",
  );

  assert.match(
    issue.body,
    /### Rationale/,
  );
});

registerTest("Anonymous contribution", () => {
  const suggestion = createBaseSuggestion();

  delete suggestion.contributor;

  const issue = formatSuggestionAsGitHubIssue(suggestion);

  assert.match(
    issue.body,
    /## Contributor\n\nAnonymous/,
  );

  assert.doesNotMatch(
    issue.body,
    /Ada Example/,
  );

  assert.doesNotMatch(
    issue.body,
    /Example Research Institute/,
  );
});

registerTest("GitHub mention neutralisation", () => {
  const suggestion = createBaseSuggestion();

  suggestion.title = "Review requested from @dangerous-user";
  suggestion.body.suggestedText =
    "This proposal mentions @dangerous-user in its suggested text.";
  suggestion.body.rationale =
    "Please ask @dangerous-team to review this change.";
  suggestion.body.sources = [
    "Source supplied by @dangerous-source.",
  ];
  suggestion.contributor = {
    displayName: "@dangerous-contributor",
    affiliation: "@dangerous-organisation",
  };

  const issue = formatSuggestionAsGitHubIssue(suggestion);
  const formattedIssue = `${issue.title}\n${issue.body}`;

  const unsafeMentions = [
    "@dangerous-user",
    "@dangerous-team",
    "@dangerous-source",
    "@dangerous-contributor",
    "@dangerous-organisation",
  ];

  for (const unsafeMention of unsafeMentions) {
    assert.ok(
      !formattedIssue.includes(unsafeMention),
      `The active mention ${unsafeMention} was not neutralised.`,
    );

    const safeMention = unsafeMention.replace(
      "@",
      "@\u200B",
    );

    assert.ok(
      formattedIssue.includes(safeMention),
      `The safe visible form of ${unsafeMention} is missing.`,
    );
  }
});

/* ========================================================================== */
/* EXECUTION                                                                  */
/* ========================================================================== */

console.log("");
console.log("GitHub Issue formatter tests");
console.log("============================");

let passedTests = 0;

for (const test of tests) {
  try {
    test.testFunction();
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
