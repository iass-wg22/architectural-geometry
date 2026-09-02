// Load the tools required to locate and read the JSON Schema file.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Ajv is the validation engine installed as a development dependency.
// This particular export supports JSON Schema draft 2020-12.
import Ajv2020 from "ajv/dist/2020.js";

/* ========================================================================== */
/* PROJECT PATHS                                                              */
/* ========================================================================== */

// Locate this script regardless of the directory from which npm is executed.
const scriptFile = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(scriptFile);
const repositoryRoot = path.resolve(scriptDirectory, "..");

const schemaPath = path.join(
  repositoryRoot,
  "prototype",
  "suggest-edit",
  "content-suggestion.schema.json",
);

/* ========================================================================== */
/* SCHEMA LOADING                                                             */
/* ========================================================================== */

// Read the schema as text, convert it to a JavaScript object and compile it.
// Ajv will stop immediately if the schema itself is malformed.
const schemaText = await readFile(schemaPath, "utf8");
const schema = JSON.parse(schemaText);

const ajv = new Ajv2020({
  allErrors: true,
});

const validateSuggestion = ajv.compile(schema);

/* ========================================================================== */
/* VALID REFERENCE CANDIDATE                                                  */
/* ========================================================================== */

// This object represents a complete and valid addition proposal.
// The other test candidates are derived from it to avoid needless repetition.
const validAddition = {
  schemaVersion: 1,
  type: "content-suggestion",
  status: "draft",
  createdAt: "2026-08-25T09:00:00.000Z",
  operation: "add",
  placement: "after",
  title: "Clarify the definition of a ruled surface",
  target: {
    source: {
      pageTitle: "Hyperbolic Paraboloid",
      pageUrl:
        "http://localhost:3000/surfaces/hyperbolic-paraboloid/home",
      sourcePath: "surfaces/hyperbolic_paraboloid/home.md",
      pageRevision: "a".repeat(64),
    },
    section: {
      title: "Geometric property and form generation",
      id: "geometric-property-and-form-generation",
      level: "h3",
    },
    selector: {
      type: "TextQuoteSelector",
      exact: "The hyperbolic paraboloid is a doubly ruled surface.",
      prefix: "Built from straight elements",
      suffix: "It contains two distinct families of straight rulings.",
    },
  },
  body: {
    suggestedText:
      "Its two families of rulings pass through every regular point.",
    rationale: "This sentence clarifies the meaning of doubly ruled.",
    sources: [
      "https://example.org/reference",
    ],
  },
};

/* ========================================================================== */
/* TEST CANDIDATES                                                            */
/* ========================================================================== */

const testCases = [
  {
    name: "Valid addition",
    expectedValidity: true,
    candidate: validAddition,
  },
  {
    name: "Valid deletion",
    expectedValidity: true,
    candidate: {
      ...validAddition,
      operation: "delete",
      placement: null,
      title: "Remove a redundant sentence",
      body: {
        ...validAddition.body,
        suggestedText: null,
        rationale: "The selected sentence repeats the previous paragraph.",
      },
    },
  },
  {
    name: "Invalid addition without suggested text",
    expectedValidity: false,
    candidate: {
      ...validAddition,
      body: {
        ...validAddition.body,
        suggestedText: "",
      },
    },
  },
  {
    name: "Invalid deletion with a placement",
    expectedValidity: false,
    candidate: {
      ...validAddition,
      operation: "delete",
      placement: "after",
      body: {
        ...validAddition.body,
        suggestedText: null,
      },
    },
  },
  {
    name: "Invalid suggestion without a rationale",
    expectedValidity: false,
    candidate: {
      ...validAddition,
      body: {
        ...validAddition.body,
        rationale: "",
      },
    },
  },
  {
    name: "Invalid suggestion with a malformed page revision",
    expectedValidity: false,
    candidate: {
      ...validAddition,
      target: {
        ...validAddition.target,
        source: {
          ...validAddition.target.source,
          pageRevision: "not-a-sha256-fingerprint",
        },
      },
    },
  },
];

/* ========================================================================== */
/* TEST EXECUTION                                                             */
/* ========================================================================== */

let successfulTests = 0;

console.log("");
console.log("Content suggestion schema tests");
console.log("================================");

for (const testCase of testCases) {
  const actualValidity = validateSuggestion(testCase.candidate);
  const testSucceeded = actualValidity === testCase.expectedValidity;

  if (testSucceeded) {
    successfulTests += 1;

    const resultDescription = actualValidity
      ? "accepted as expected"
      : "rejected as expected";

    console.log(`PASS - ${testCase.name}: ${resultDescription}.`);
    continue;
  }

  console.error(`FAIL - ${testCase.name}`);
  console.error(
    `  Expected validity: ${testCase.expectedValidity}`,
  );
  console.error(`  Actual validity: ${actualValidity}`);

  if (validateSuggestion.errors) {
    console.error(
      ajv.errorsText(validateSuggestion.errors, {
        separator: "\n  ",
      }),
    );
  }
}

/* ========================================================================== */
/* FINAL RESULT                                                               */
/* ========================================================================== */

console.log("");
console.log(`${successfulTests}/${testCases.length} tests passed.`);
console.log("");

// A non-zero exit code tells GitHub Actions and npm that at least one test
// produced an unexpected result.
if (successfulTests !== testCases.length) {
  process.exitCode = 1;
}