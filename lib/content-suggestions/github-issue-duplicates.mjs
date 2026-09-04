import {
  createSuggestionIssueMarker,
} from "./github-issue-formatter.mjs";

function normalizeRequiredText(value, fieldName) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`The GitHub ${fieldName} is missing.`);
  }

  return value.trim();
}

function validateRepository(repository) {
  const normalizedRepository = normalizeRequiredText(
    repository,
    "repository",
  );

  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalizedRepository)) {
    throw new Error(
      `The GitHub repository is invalid: ${normalizedRepository}.`,
    );
  }

  return normalizedRepository;
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

export function findExistingGitHubIssueBySuggestionId({
  suggestionId,
  repository,
  repositoryItems,
}) {
  const safeRepository = validateRepository(repository);
  const suggestionMarker = createSuggestionIssueMarker(
    suggestionId,
  );

  if (!Array.isArray(repositoryItems)) {
    throw new Error(
      "GitHub returned an unexpected Issue-list response.",
    );
  }

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
