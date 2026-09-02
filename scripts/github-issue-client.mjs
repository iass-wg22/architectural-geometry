import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";

import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  createSuggestionIssueMarker,
} from "./format-suggestion-issue.mjs";

/* ========================================================================== */
/* DEVELOPMENT SAFETY CONFIGURATION                                           */
/* ========================================================================== */

// The local prototype is deliberately restricted to the personal fork.
// This module refuses every other destination, including the official WG22
// repository. Production delivery will later use a separate GitHub App.
export const developmentGitHubRepository =
  "evetillard/architectural-geometry";

/* ========================================================================== */
/* INPUT VALIDATION                                                           */
/* ========================================================================== */

function normalizeRequiredText(value, fieldName) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`The GitHub Issue ${fieldName} is missing.`);
  }

  return value.trim();
}

function validateIssue(issue) {
  if (!issue || typeof issue !== "object") {
    throw new Error("The formatted GitHub Issue is missing or invalid.");
  }

  const title = normalizeRequiredText(issue.title, "title");
  const body = normalizeRequiredText(issue.body, "body");
  const suggestionId = normalizeRequiredText(
    issue.suggestionId,
    "suggestion ID",
  ).toLowerCase();

  const suggestionMarker = createSuggestionIssueMarker(
    suggestionId,
  );

  if (!body.includes(suggestionMarker)) {
    throw new Error(
      "The formatted GitHub Issue does not contain its suggestion marker.",
    );
  }

  if (title.length > 256) {
    throw new Error(
      `The GitHub Issue title is too long: ${title.length} characters.`,
    );
  }

  if (!Array.isArray(issue.labels) || issue.labels.length === 0) {
    throw new Error("The GitHub Issue labels are missing.");
  }

  const labels = issue.labels.map((label, index) =>
    normalizeRequiredText(label, `label at index ${index}`),
  );

  return {
    title,
    body,
    labels,
    suggestionId,
    suggestionMarker,
  };
}

function validateRepository(repository) {
  const normalizedRepository = normalizeRequiredText(
    repository,
    "repository",
  );

  if (
    normalizedRepository.toLowerCase() !==
    developmentGitHubRepository.toLowerCase()
  ) {
    throw new Error(
      `Refusing to create a development Issue outside ${developmentGitHubRepository}.`,
    );
  }

  return developmentGitHubRepository;
}

/* ========================================================================== */
/* GITHUB CLI EXECUTION                                                       */
/* ========================================================================== */

function runGitHubCli(argumentsList) {
  return new Promise((resolve, reject) => {
    const command = spawn("gh", argumentsList, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let standardOutput = "";
    let standardError = "";
    let commandFinished = false;

    command.stdout.setEncoding("utf8");
    command.stderr.setEncoding("utf8");

    command.stdout.on("data", (chunk) => {
      standardOutput += chunk;
    });

    command.stderr.on("data", (chunk) => {
      standardError += chunk;
    });

    command.on("error", (error) => {
      if (commandFinished) {
        return;
      }

      commandFinished = true;

      reject(
        new Error(`Unable to launch GitHub CLI: ${error.message}`),
      );
    });

    command.on("close", (exitCode) => {
      if (commandFinished) {
        return;
      }

      commandFinished = true;

      if (exitCode !== 0) {
        reject(
          new Error(
            standardError.trim() ||
              standardOutput.trim() ||
              `GitHub CLI exited with code ${exitCode}.`,
          ),
        );
        return;
      }

      resolve({
        standardOutput: standardOutput.trim(),
        standardError: standardError.trim(),
      });
    });
  });
}

/* ========================================================================== */
/* ACCESS VERIFICATION                                                        */
/* ========================================================================== */

export async function verifyDevelopmentGitHubAccess(
  repository = developmentGitHubRepository,
) {
  const safeRepository = validateRepository(repository);

  await runGitHubCli([
    "auth",
    "status",
    "--hostname",
    "github.com",
  ]);

  const repositoryResult = await runGitHubCli([
    "repo",
    "view",
    safeRepository,
    "--json",
    "nameWithOwner,hasIssuesEnabled",
    "--jq",
    "[.nameWithOwner, .hasIssuesEnabled] | @tsv",
  ]);

  const [resolvedRepository, issuesEnabledText] =
    repositoryResult.standardOutput.split("\t");

  if (
    resolvedRepository?.toLowerCase() !==
    safeRepository.toLowerCase()
  ) {
    throw new Error(
      `GitHub CLI did not resolve the expected repository: ${safeRepository}.`,
    );
  }

  if (issuesEnabledText !== "true") {
    throw new Error(
      `GitHub Issues are disabled for ${safeRepository}.`,
    );
  }

  return {
    repository: safeRepository,
    issuesEnabled: true,
  };
}

/* ========================================================================== */
/* EXISTING ISSUE LOOKUP                                                      */
/* ========================================================================== */

function parsePaginatedIssueResponse(commandOutput) {
  let pages;

  try {
    pages = JSON.parse(commandOutput);
  } catch (error) {
    throw new Error(
      `GitHub CLI returned invalid Issue-list JSON: ${error.message}`,
    );
  }

  if (
    !Array.isArray(pages) ||
    pages.some((page) => !Array.isArray(page))
  ) {
    throw new Error(
      "GitHub CLI returned an unexpected paginated Issue-list response.",
    );
  }

  return pages.flat();
}

function extractExistingIssueInformation(issue, repository) {
  const issueNumber = issue?.number;
  const issueUrl = issue?.html_url;

  if (!Number.isInteger(issueNumber) || issueNumber < 1) {
    throw new Error(
      "GitHub returned an existing Issue without a valid number.",
    );
  }

  const expectedIssueUrl =
    `https://github.com/${repository}/issues/${issueNumber}`;

  if (
    typeof issueUrl !== "string" ||
    issueUrl.replace(/\/$/, "").toLowerCase() !==
      expectedIssueUrl.toLowerCase()
  ) {
    throw new Error(
      `GitHub returned an unexpected Issue URL for #${issueNumber}.`,
    );
  }

  return {
    provider: "github",
    repository,
    issueNumber,
    issueUrl: expectedIssueUrl,
    reused: true,
  };
}

export async function findDevelopmentGitHubIssueBySuggestionId(
  suggestionId,
  {
    repository = developmentGitHubRepository,
    verifyAccess = true,
  } = {},
) {
  const safeRepository = validateRepository(repository);
  const suggestionMarker = createSuggestionIssueMarker(
    suggestionId,
  );

  if (verifyAccess) {
    await verifyDevelopmentGitHubAccess(safeRepository);
  }

  // The REST endpoint is intentionally paginated instead of relying on the
  // GitHub search index. This makes an Issue discoverable immediately after
  // creation and compares the complete, exact marker stored in its body.
  const issueListResult = await runGitHubCli([
    "api",
    `repos/${safeRepository}/issues?state=all&per_page=100`,
    "--paginate",
    "--slurp",
  ]);

  const repositoryItems = parsePaginatedIssueResponse(
    issueListResult.standardOutput,
  );

  const matchingIssues = repositoryItems.filter(
    (repositoryItem) =>
      !repositoryItem?.pull_request &&
      typeof repositoryItem?.body === "string" &&
      repositoryItem.body.includes(suggestionMarker),
  );

  if (matchingIssues.length === 0) {
    return null;
  }

  if (matchingIssues.length > 1) {
    const duplicateNumbers = matchingIssues
      .map((issue) => `#${issue.number}`)
      .join(", ");

    throw new Error(
      `Multiple GitHub Issues contain suggestion ${suggestionId}: ${duplicateNumbers}.`,
    );
  }

  return extractExistingIssueInformation(
    matchingIssues[0],
    safeRepository,
  );
}

/* ========================================================================== */
/* ISSUE CREATION                                                             */
/* ========================================================================== */

function extractIssueInformation(commandOutput, repository) {
  const outputLines = String(commandOutput || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const issueUrl = [...outputLines]
    .reverse()
    .find((line) => /^https:\/\/github\.com\/.+\/issues\/\d+\/?$/i.test(line));

  if (!issueUrl) {
    throw new Error(
      "GitHub CLI created an Issue but did not return a recognisable URL.",
    );
  }

  const issueNumberMatch = issueUrl.match(/\/issues\/(\d+)\/?$/i);

  if (!issueNumberMatch) {
    throw new Error(
      `Unable to determine the Issue number from ${issueUrl}.`,
    );
  }

  return {
    provider: "github",
    repository,
    issueNumber: Number(issueNumberMatch[1]),
    issueUrl,
    reused: false,
  };
}

export async function createDevelopmentGitHubIssue(
  issue,
  {
    repository = developmentGitHubRepository,
    verifyAccess = true,
  } = {},
) {
  const safeIssue = validateIssue(issue);
  const safeRepository = validateRepository(repository);

  if (verifyAccess) {
    await verifyDevelopmentGitHubAccess(safeRepository);
  }

  const existingIssue =
    await findDevelopmentGitHubIssueBySuggestionId(
      safeIssue.suggestionId,
      {
        repository: safeRepository,
        verifyAccess: false,
      },
    );

  if (existingIssue) {
    return existingIssue;
  }

  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "architectural-geometry-issue-"),
  );

  const bodyFilePath = path.join(
    temporaryDirectory,
    "issue-body.md",
  );

  try {
    await writeFile(bodyFilePath, safeIssue.body, "utf8");

    const labelArguments = safeIssue.labels.flatMap((label) => [
      "--label",
      label,
    ]);

    const creationResult = await runGitHubCli([
      "issue",
      "create",
      "--repo",
      safeRepository,
      "--title",
      safeIssue.title,
      "--body-file",
      bodyFilePath,
      ...labelArguments,
    ]);

    return extractIssueInformation(
      creationResult.standardOutput,
      safeRepository,
    );
  } finally {
    await rm(temporaryDirectory, {
      recursive: true,
      force: true,
    });
  }
}
