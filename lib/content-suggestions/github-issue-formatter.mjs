/* ========================================================================== */
/* TEXT UTILITIES                                                             */
/* ========================================================================== */

function normalizeLine(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

// MyST adds a pilcrow character to some rendered heading labels.
// It is useful as an anchor in the web page but should not appear
// in the moderator-facing GitHub Issue.
function normalizeSectionTitle(value) {
  return normalizeLine(value)
    .replace(/\s*¶+\s*$/u, "");
}

function normalizeMultiline(value) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .trim();
}

// Keep the original TextQuoteSelector untouched for future anchoring while
// making its surrounding context pleasant to read in the GitHub Issue.
function normalizeContextForDisplay(value) {
  return normalizeMultiline(value)
    .replace(/\s*¶+\s*/gu, " ")
    .replace(/([.!?:;])(?=[A-ZÀ-ÖØ-Þ])/gu, "$1 ")
    .replace(/\s+/g, " ")
    .trim();
}

// Prevent submitted text from notifying arbitrary GitHub users through
// mentions such as @username or @organisation.
function neutralizeGitHubMentions(value) {
  return String(value).replaceAll("@", "@\u200B");
}

function formatQuotedText(value, fallback = "Not provided.") {
  const normalizedText = normalizeMultiline(value);

  if (!normalizedText) {
    return `> ${fallback}`;
  }

  return neutralizeGitHubMentions(normalizedText)
    .split("\n")
    .map((line) => `> ${line || " "}`)
    .join("\n");
}

function formatTechnicalValue(value, fallback = "Not available") {
  const normalizedValue = normalizeLine(value);

  if (!normalizedValue) {
    return fallback;
  }

  return normalizedValue.replaceAll("`", "'");
}

/* ========================================================================== */
/* SUGGESTION INTERPRETATION                                                  */
/* ========================================================================== */

function getSuggestion(input) {
  // Accept either:
  // - a raw suggestion draft;
  // - a stored record containing { suggestion: ... }.
  return input?.suggestion ?? input;
}

// Every suggestion saved by the storage server receives a UUID. Including
// that identifier in the GitHub Issue gives the local record and the public
// discussion a stable, machine-readable relationship.
export const suggestionIssueMarkerName =
  "architectural-geometry-suggestion-id";

const suggestionRecordIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createSuggestionIssueMarker(suggestionRecordId) {
  const normalizedRecordId = normalizeLine(
    suggestionRecordId,
  ).toLowerCase();

  if (!suggestionRecordIdPattern.test(normalizedRecordId)) {
    throw new Error(
      "The stored suggestion ID is missing or is not a valid UUID.",
    );
  }

  return `<!-- ${suggestionIssueMarkerName}: ${normalizedRecordId} -->`;
}

function getStoredSuggestionRecordId(input) {
  const isStoredRecord =
    input !== null &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    Object.hasOwn(input, "suggestion");

  if (!isStoredRecord) {
    return null;
  }

  const normalizedRecordId = normalizeLine(
    input.id,
  ).toLowerCase();

  // A stored record without a trustworthy identifier must not produce an
  // untraceable public Issue.
  createSuggestionIssueMarker(normalizedRecordId);

  return normalizedRecordId;
}

function getOperationDetails(suggestion) {
  const operation = normalizeLine(
    suggestion.operation,
  ).toLowerCase();

  const placement = normalizeLine(
    suggestion.placement,
  ).toLowerCase();

  if (operation === "add" || operation === "addition") {
    const placementDescription =
      placement === "before"
        ? "Add text before the selected passage"
        : placement === "after"
          ? "Add text after the selected passage"
          : "Add text near the selected passage";

    return {
      operation: "add",
      label: "Addition",
      description: placementDescription,
    };
  }

  if (
    operation === "delete" ||
    operation === "deletion"
  ) {
    return {
      operation: "delete",
      label: "Deletion",
      description: "Delete the selected passage",
    };
  }

  throw new Error(
    `Unsupported suggestion operation: ${
      operation || "missing"
    }`,
  );
}

function formatSources(sources) {
  if (!Array.isArray(sources) || sources.length === 0) {
    return "> No sources provided.";
  }

  return sources
    .map((source) => {
      const sourceText =
        typeof source === "string"
          ? source
          : source?.text ??
            source?.citation ??
            source?.url ??
            JSON.stringify(source);

      return formatQuotedText(sourceText);
    })
    .join("\n>\n");
}

function formatContributor(contributor) {
  const displayName = normalizeLine(
    contributor?.displayName,
  );

  const affiliation = normalizeLine(
    contributor?.affiliation,
  );

  if (!displayName && !affiliation) {
    return "Anonymous";
  }

  if (displayName && affiliation) {
    return `${neutralizeGitHubMentions(
      displayName,
    )} — ${neutralizeGitHubMentions(affiliation)}`;
  }

  return neutralizeGitHubMentions(
    displayName || affiliation,
  );
}

/* ========================================================================== */
/* GITHUB ISSUE FORMATTER                                                     */
/* ========================================================================== */

export function formatSuggestionAsGitHubIssue(input) {
  const suggestion = getSuggestion(input);

  const suggestionRecordId =
    getStoredSuggestionRecordId(input);

  if (!suggestion || typeof suggestion !== "object") {
    throw new Error(
      "The suggestion is missing or invalid.",
    );
  }

  const suggestionTitle = normalizeLine(
    suggestion.title,
  );

  if (!suggestionTitle) {
    throw new Error(
      "The suggestion title is missing.",
    );
  }

  const operation = getOperationDetails(suggestion);

  const source = suggestion.target?.source ?? {};
  const section = suggestion.target?.section ?? {};
  const selector = suggestion.target?.selector ?? {};
  const body = suggestion.body ?? {};
  const contributor = suggestion.contributor ?? {};

  const issueTitle = neutralizeGitHubMentions(
    `[Content suggestion] ${suggestionTitle}`,
  ).slice(0, 240);

  const sectionTitle = normalizeSectionTitle(
    section.title,
  );

  const suggestionIssueMarker = suggestionRecordId
    ? createSuggestionIssueMarker(suggestionRecordId)
    : null;

  const issueBody = [
    "## Target",
    "",
    `- **Page:** ${formatTechnicalValue(
      source.pageTitle,
    )}`,
    `- **Section:** ${formatTechnicalValue(
      sectionTitle,
    )}`,
    `- **Source file:** \`${formatTechnicalValue(
      source.sourcePath,
    )}\``,
    `- **Page revision:** \`${formatTechnicalValue(
      source.pageRevision,
    )}\``,
    `- **Page URL:** ${formatTechnicalValue(
      source.pageUrl,
    )}`,
    "",
    "## Proposed change",
    "",
    `- **Operation:** ${operation.label}`,
    `- **Requested action:** ${operation.description}`,
    "",
    "### Selected passage",
    "",
    formatQuotedText(selector.exact),
    "",
    ...(operation.operation === "add"
      ? [
          "### Suggested text",
          "",
          formatQuotedText(body.suggestedText),
          "",
        ]
      : []),
    "### Rationale",
    "",
    formatQuotedText(body.rationale),
    "",
    "### Sources",
    "",
    formatSources(body.sources),
    "",
    "## Contributor",
    "",
    formatContributor(contributor),
    "",
    "<details>",
    "<summary>Editorial anchoring context</summary>",
    "",
    "### Text before the selection",
    "",
    formatQuotedText(
      normalizeContextForDisplay(selector.prefix),
    ),
    "",
    "### Text after the selection",
    "",
    formatQuotedText(
      normalizeContextForDisplay(selector.suffix),
    ),
    "",
    "</details>",
    "",
    "---",
    "",
    "_Submitted through the Architectural Geometry contribution interface._",
    ...(suggestionIssueMarker
      ? ["", suggestionIssueMarker]
      : []),
  ].join("\n");

  return {
    title: issueTitle,
    body: issueBody,
    suggestionId: suggestionRecordId,
    labels: [
      "content-suggestion",
      `operation:${operation.operation}`,
      "status:open",
    ],
  };
}

