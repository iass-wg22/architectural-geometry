import {
  findExistingGitHubIssueBySuggestionId,
} from "../../lib/content-suggestions/github-issue-duplicates.mjs";

import {
  createSuggestionIssueMarker,
} from "../../lib/content-suggestions/github-issue-formatter.mjs";

import {
  getGitHubInstallationAccessToken,
} from "./github-app-auth.mjs";

const GITHUB_API_BASE_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";


function requireText(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`The ${name} value is missing.`);
  }

  return value.trim();
}

function getConfiguredRepository(env) {
  const owner = requireText(
    env.GITHUB_REPOSITORY_OWNER,
    "GITHUB_REPOSITORY_OWNER",
  );

  const repositoryName = requireText(
    env.GITHUB_REPOSITORY_NAME,
    "GITHUB_REPOSITORY_NAME",
  );

  const repositoryComponentPattern =
    /^[A-Za-z0-9._-]+$/u;

  if (
    !repositoryComponentPattern.test(owner) ||
    !repositoryComponentPattern.test(repositoryName)
  ) {
    throw new Error(
      "The configured GitHub repository contains invalid characters.",
    );
  }

  return `${owner}/${repositoryName}`;
}

function validateFormattedIssue(issue) {
  if (!issue || typeof issue !== "object") {
    throw new Error("The formatted GitHub Issue is missing.");
  }

  const title = requireText(issue.title, "Issue title");
  const body = requireText(issue.body, "Issue body");
  const suggestionId = requireText(issue.suggestionId, "suggestion ID").toLowerCase();
  const marker = createSuggestionIssueMarker(suggestionId);

  if (!body.includes(marker)) {
    throw new Error("The formatted Issue does not contain its suggestion marker.");
  }

  return {
    title,
    body,
    suggestionId,
    labels: Array.isArray(issue.labels)
      ? issue.labels.map((label) => requireText(label, "Issue label"))
      : [],
  };
}

async function readGitHubError(response) {
  try {
    const body = await response.json();
    return body?.message || `GitHub returned HTTP ${response.status}.`;
  } catch {
    return `GitHub returned HTTP ${response.status}.`;
  }
}

async function githubRequest(
  path,
  { token, fetchImplementation, method = "GET", body } = {},
) {
  const response = await fetchImplementation(`${GITHUB_API_BASE_URL}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      "User-Agent": "architectural-geometry-suggestions-worker",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  if (!response.ok) {
    throw new Error(`GitHub API request failed: ${await readGitHubError(response)}`);
  }

  return response;
}

async function listRepositoryIssues({ repository, token, fetchImplementation }) {
  const repositoryItems = [];

  for (let page = 1; page <= 100; page += 1) {
    const response = await githubRequest(
      `/repos/${repository}/issues?state=all&per_page=100&page=${page}`,
      { token, fetchImplementation },
    );
    const pageItems = await response.json();

    if (!Array.isArray(pageItems)) {
      throw new Error("GitHub returned an unexpected Issue-list response.");
    }

    repositoryItems.push(...pageItems);

    if (pageItems.length < 100) {
      return repositoryItems;
    }
  }

  throw new Error("GitHub Issue pagination exceeded the safety limit.");
}

function extractCreatedIssue(issue, repository) {
  if (!Number.isInteger(issue?.number) || issue.number < 1) {
    throw new Error("GitHub created an Issue without returning a valid number.");
  }

  const expectedUrl = `https://github.com/${repository}/issues/${issue.number}`;

  if (
    typeof issue.html_url !== "string" ||
    issue.html_url.replace(/\/$/u, "").toLowerCase() !== expectedUrl.toLowerCase()
  ) {
    throw new Error("GitHub returned an unexpected URL for the created Issue.");
  }

  return {
    provider: "github",
    repository,
    issueNumber: issue.number,
    issueUrl: expectedUrl,
    reused: false,
  };
}

export function createGitHubAppIssueDelivery({
  env,
  fetchImplementation = fetch,
  tokenProvider = getGitHubInstallationAccessToken,
} = {}) {
  if (!env || typeof env !== "object") {
    throw new Error("GitHub App delivery requires Worker configuration.");
  }

  return async function deliverIssue(issue) {
    const safeIssue = validateFormattedIssue(issue);
    const repository = getConfiguredRepository(env);
    const token = await tokenProvider(env, { fetchImplementation });
    const repositoryItems = await listRepositoryIssues({
      repository,
      token,
      fetchImplementation,
    });
    const existingIssue = findExistingGitHubIssueBySuggestionId({
      suggestionId: safeIssue.suggestionId,
      repository,
      repositoryItems,
    });

    if (existingIssue) {
      return existingIssue;
    }

    const response = await githubRequest(`/repos/${repository}/issues`, {
      token,
      fetchImplementation,
      method: "POST",
      body: {
        title: safeIssue.title,
        body: safeIssue.body,
        labels: safeIssue.labels,
      },
    });

    return extractCreatedIssue(await response.json(), repository);
  };
}
