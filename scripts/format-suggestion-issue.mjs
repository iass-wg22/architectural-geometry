import {
  readdir,
  readFile,
  stat,
} from "node:fs/promises";

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createSuggestionIssueMarker,
  formatSuggestionAsGitHubIssue,
  suggestionIssueMarkerName,
} from "../lib/content-suggestions/github-issue-formatter.mjs";

export {
  createSuggestionIssueMarker,
  formatSuggestionAsGitHubIssue,
  suggestionIssueMarkerName,
};

const scriptFile = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(scriptFile);
const repositoryRoot = path.resolve(scriptDirectory, "..");

const suggestionsDirectory = path.join(
  repositoryRoot,
  ".local-data",
  "suggestions",
);

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

async function runCommandLinePreview() {
  const requestedPath = process.argv[2];

  const suggestionFilePath = requestedPath
    ? path.resolve(repositoryRoot, requestedPath)
    : await findLatestStoredSuggestion();

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
  console.log("GitHub Issue preview");
  console.log("====================");
  console.log("");
  console.log("Source record:");
  console.log(
    path.relative(
      repositoryRoot,
      suggestionFilePath,
    ),
  );
  console.log("");
  console.log("TITLE");
  console.log("-----");
  console.log(issue.title);
  console.log("");
  console.log("LABELS");
  console.log("------");
  console.log(issue.labels.join(", "));
  console.log("");
  console.log("BODY");
  console.log("----");
  console.log(issue.body);
  console.log("");
}

const isDirectExecution =
  process.argv[1] &&
  path.resolve(process.argv[1]) === scriptFile;

if (isDirectExecution) {
  runCommandLinePreview().catch((error) => {
    console.error("");
    console.error(
      "Unable to format the GitHub Issue preview.",
    );
    console.error(error.message);
    console.error("");

    process.exitCode = 1;
  });
}
