import {
  readFile,
  readdir,
  stat,
} from "node:fs/promises";

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  formatSuggestionAsGitHubIssue,
} from "./format-suggestion-issue.mjs";

import {
  createDevelopmentGitHubIssue,
  developmentGitHubRepository,
} from "./github-issue-client.mjs";

/* ========================================================================== */
/* PROJECT PATHS                                                              */
/* ========================================================================== */

const scriptFile = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(scriptFile);
const repositoryRoot = path.resolve(scriptDirectory, "..");

const suggestionsDirectory = path.join(
  repositoryRoot,
  ".local-data",
  "suggestions",
);

/* ========================================================================== */
/* COMMAND-LINE ARGUMENTS                                                     */
/* ========================================================================== */

function readCommandLineArguments() {
  const argumentsList = process.argv.slice(2);
  let confirmed = false;
  let requestedFile = null;

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];

    if (argument === "--confirm") {
      confirmed = true;
      continue;
    }

    if (argument === "--file") {
      requestedFile = argumentsList[index + 1];

      if (!requestedFile) {
        throw new Error(
          "The --file option requires a JSON file path.",
        );
      }

      index += 1;
      continue;
    }

    throw new Error(`Unsupported argument: ${argument}`);
  }

  return {
    confirmed,
    requestedFile,
  };
}

/* ========================================================================== */
/* STORED SUGGESTION SELECTION                                                */
/* ========================================================================== */

async function findLatestStoredSuggestion() {
  let entries;

  try {
    entries = await readdir(suggestionsDirectory, {
      withFileTypes: true,
    });
  } catch {
    throw new Error(
      "No local suggestion directory was found. Submit a suggestion first.",
    );
  }

  const suggestionFiles = entries.filter(
    (entry) =>
      entry.isFile() &&
      entry.name.endsWith(".json"),
  );

  if (suggestionFiles.length === 0) {
    throw new Error(
      "No stored suggestion was found.",
    );
  }

  const candidates = await Promise.all(
    suggestionFiles.map(async (entry) => {
      const filePath = path.join(
        suggestionsDirectory,
        entry.name,
      );

      const fileInformation = await stat(filePath);

      return {
        filePath,
        modifiedAt: fileInformation.mtimeMs,
      };
    }),
  );

  candidates.sort(
    (firstCandidate, secondCandidate) =>
      secondCandidate.modifiedAt -
      firstCandidate.modifiedAt,
  );

  return candidates[0].filePath;
}

async function resolveSuggestionFile(requestedFile) {
  if (!requestedFile) {
    return findLatestStoredSuggestion();
  }

  return path.resolve(repositoryRoot, requestedFile);
}

/* ========================================================================== */
/* MAIN COMMAND                                                               */
/* ========================================================================== */

async function main() {
  const commandLine = readCommandLineArguments();

  const suggestionFilePath = await resolveSuggestionFile(
    commandLine.requestedFile,
  );

  const storedContent = await readFile(
    suggestionFilePath,
    "utf8",
  );

  const storedSuggestion = JSON.parse(
    storedContent,
  );

  const issue = formatSuggestionAsGitHubIssue(
    storedSuggestion,
  );

  console.log("");
  console.log("GitHub Issue test launcher");
  console.log("==========================");
  console.log("");
  console.log(
    `Repository: ${developmentGitHubRepository}`,
  );
  console.log(
    `Source record: ${path.relative(
      repositoryRoot,
      suggestionFilePath,
    )}`,
  );
  console.log(`Title: ${issue.title}`);
  console.log(`Labels: ${issue.labels.join(", ")}`);
  console.log("");

  if (!commandLine.confirmed) {
    console.log("DRY RUN: no GitHub Issue was created.");
    console.log("");
    console.log("Review the complete body with:");
    console.log("  npm run preview:issue");
    console.log("");
    console.log("Create the Issue on the personal fork with:");
    console.log(
      "  node scripts/create-test-github-issue.mjs --confirm",
    );
    console.log("");
    return;
  }

  console.log(
    "Confirmation received. Creating the Issue through the shared GitHub client...",
  );

  const delivery = await createDevelopmentGitHubIssue(
    issue,
  );

  console.log("");
  console.log("GitHub Issue created successfully:");
  console.log(`Repository: ${delivery.repository}`);
  console.log(`Issue number: ${delivery.issueNumber}`);
  console.log(`Issue URL: ${delivery.issueUrl}`);
  console.log("");
}

main().catch((error) => {
  console.error("");
  console.error(
    "Unable to create the GitHub test Issue.",
  );
  console.error(error.message);
  console.error("");

  process.exitCode = 1;
});
