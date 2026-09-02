function initializeSuggestEdit() {
  "use strict";

  /* ======================================================================== */
  /* PREVIOUS PROTOTYPE CLEANUP                                               */
  /* ======================================================================== */

  // Remove the previous injected version before installing this version.
  window.suggestEditPrototype?.destroy?.();

  // Also remove stale elements left behind by a previously interrupted script.
  document.getElementById("suggest-edit-action")?.remove();
  document.getElementById("suggest-edit-dialog")?.remove();
  document.getElementById("suggest-edit-prototype-styles")?.remove();

  /* ======================================================================== */
  /* PAGE CONTENT AND PROTOTYPE CONFIGURATION                                 */
  /* ======================================================================== */

  // Retrieve the current scientific content whenever it is needed.
  // Remix may replace the <main> element during client-side navigation, so
  // keeping a reference captured when the script loads would become stale.
  function getMainContent() {
    return document.querySelector("main");
  }

  if (!getMainContent()) {
    console.error("[Suggest an edit] Main page content was not found.");
    return;
  }

  // Number of contextual characters retained on each side of the selection.
  const contextCharacterLimit = 160;

  // Development API used while the public storage service is not deployed.
  // Keeping this value in one place will make the production endpoint easy to
  // substitute later without changing the form logic.
  const suggestionSubmissionUrl =
    "http://127.0.0.1:8787/api/suggestions";

  /* ======================================================================== */
  /* PROTOTYPE STATE                                                          */
  /* ======================================================================== */

  let capturedSelection = null;
  let activeAnchor = null;
  let lastDraft = null;

  /* ======================================================================== */
  /* USER INTERFACE CREATION                                                  */
  /* ======================================================================== */

  const actionButton = document.createElement("button");

  actionButton.id = "suggest-edit-action";
  actionButton.className = "suggest-edit-action";
  actionButton.type = "button";
  actionButton.textContent = "Suggest an edit";
  actionButton.hidden = true;

  const dialog = document.createElement("dialog");

  dialog.id = "suggest-edit-dialog";
  dialog.className = "suggest-edit-dialog";
  dialog.setAttribute("aria-labelledby", "suggest-edit-dialog-title");

  dialog.innerHTML = `
    <div class="suggest-edit-dialog__body">
      <header class="suggest-edit-dialog__header">
        <div>
          <p class="suggest-edit-dialog__eyebrow">Content suggestion</p>
          <h2 id="suggest-edit-dialog-title">Suggest an edit</h2>
        </div>
        <button
          class="suggest-edit-dialog__close"
          id="suggest-edit-dialog-close"
          type="button"
          aria-label="Close suggestion form"
        >
          ×
        </button>
      </header>

      <div class="suggest-edit-context" aria-label="Selected passage context">
        <dl class="suggest-edit-context__metadata">
          <div>
            <dt>Page</dt>
            <dd id="suggest-edit-page-title"></dd>
          </div>
          <div>
            <dt>Section</dt>
            <dd id="suggest-edit-section-title"></dd>
          </div>
        </dl>

        <p class="suggest-edit-context__label">Selected passage</p>
        <blockquote id="suggest-edit-selected-text"></blockquote>
      </div>

      <form id="suggest-edit-form">
        <div class="suggest-edit-field">
          <label for="suggest-edit-operation">Operation</label>
          <select id="suggest-edit-operation" name="operation" required>
            <option value="add">Add text</option>
            <option value="delete">Delete selected text</option>
          </select>
        </div>

        <fieldset id="suggest-edit-placement-group">
          <legend>Insertion position</legend>
          <label class="suggest-edit-choice">
            <input type="radio" name="placement" value="before">
            Before the selected passage
          </label>
          <label class="suggest-edit-choice">
            <input type="radio" name="placement" value="after" checked>
            After the selected passage
          </label>
        </fieldset>

        <div class="suggest-edit-field">
          <label for="suggest-edit-title">Suggestion title</label>
          <input
            id="suggest-edit-title"
            name="title"
            type="text"
            maxlength="160"
            autocomplete="off"
            placeholder="Give a title to your suggestion"
            required
          >
        </div>

        <div class="suggest-edit-field" id="suggest-edit-text-group">
          <label for="suggest-edit-text">Text to add</label>
          <textarea
            id="suggest-edit-text"
            name="suggestedText"
            rows="5"
            placeholder="Write the proposed text here."
            required
          ></textarea>
        </div>

        <div class="suggest-edit-field">
          <label for="suggest-edit-rationale">Rationale</label>
          <textarea
            id="suggest-edit-rationale"
            name="rationale"
            rows="4"
            placeholder="Explain why this change would improve the page."
            required
          ></textarea>
        </div>

        <div class="suggest-edit-field">
          <label for="suggest-edit-sources">Sources <span>(optional)</span></label>
          <textarea
            id="suggest-edit-sources"
            name="sources"
            rows="3"
            placeholder="Enter one reference or URL per line."
          ></textarea>
        </div>

        <div class="suggest-edit-field">
          <label for="suggest-edit-contributor-name">
            Name or pseudonym <span>(optional)</span>
          </label>
          <input
            id="suggest-edit-contributor-name"
            name="contributorName"
            type="text"
            maxlength="160"
            autocomplete="off"
            placeholder="Your name or preferred pseudonym"
          >
          <small>
            If provided, this information may be displayed publicly with your
            suggestion.
          </small>
        </div>

        <div class="suggest-edit-field">
          <label for="suggest-edit-contributor-affiliation">
            Affiliation <span>(optional)</span>
          </label>
          <input
            id="suggest-edit-contributor-affiliation"
            name="contributorAffiliation"
            type="text"
            maxlength="200"
            autocomplete="organization"
            placeholder="University, practice, company or independent contributor"
          >
        </div>

        <p
          class="suggest-edit-form-error"
          id="suggest-edit-form-error"
          role="alert"
          hidden
        ></p>

        <div class="suggest-edit-actions">
          <button id="suggest-edit-cancel" type="button">Cancel</button>
          <button
            class="suggest-edit-primary"
            id="suggest-edit-preview-button"
            type="submit"
          >
            Preview suggestion
          </button>
        </div>
      </form>

      <section
        id="suggest-edit-preview-section"
        aria-labelledby="suggest-edit-preview-heading"
        hidden
      >
        <p class="suggest-edit-dialog__eyebrow">Review</p>
        <h3 id="suggest-edit-preview-heading">Suggestion preview</h3>

        <div class="suggest-edit-preview-notice" role="status">
          <strong>Preview ready.</strong>
          This suggestion has not been submitted.
        </div>

        <div id="suggest-edit-preview"></div>

        <div
          class="suggest-edit-submission-result"
          id="suggest-edit-submission-result"
          role="status"
          aria-live="polite"
          hidden
        ></div>

        <div class="suggest-edit-preview-actions">
          <button id="suggest-edit-back-to-form" type="button">
            Back to editing
          </button>
          <button
            class="suggest-edit-primary"
            id="suggest-edit-submit-suggestion"
            type="button"
          >
            Submit suggestion
          </button>
        </div>
      </section>
    </div>
  `;

  const styleElement = document.createElement("style");

  styleElement.id = "suggest-edit-prototype-styles";
  styleElement.textContent = `
    .suggest-edit-action {
      position: fixed;
      z-index: 99999;
      padding: 9px 13px;
      border: 1px solid rgba(255, 255, 255, 0.25);
      border-radius: 999px;
      background: #1f2937;
      color: #ffffff;
      font: 600 14px/1.3 system-ui, sans-serif;
      cursor: pointer;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
    }

    .suggest-edit-action:hover {
      background: #111827;
    }

    .suggest-edit-action:focus-visible,
    .suggest-edit-dialog button:focus-visible,
    .suggest-edit-dialog input:focus-visible,
    .suggest-edit-dialog select:focus-visible,
    .suggest-edit-dialog textarea:focus-visible {
      outline: 3px solid #60a5fa;
      outline-offset: 2px;
    }

    .suggest-edit-dialog {
      width: min(720px, calc(100vw - 32px));
      max-width: none;
      max-height: min(88vh, 900px);
      padding: 0;
      border: 1px solid color-mix(in srgb, CanvasText 18%, transparent);
      border-radius: 16px;
      background: Canvas;
      color: CanvasText;
      color-scheme: light dark;
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.35);
    }

    .suggest-edit-dialog::backdrop {
      background: rgba(15, 23, 42, 0.68);
      backdrop-filter: blur(2px);
    }

    .suggest-edit-dialog__body {
      padding: 24px;
      overflow: auto;
    }

    .suggest-edit-dialog__header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 20px;
      margin-bottom: 20px;
    }

    .suggest-edit-dialog__header h2,
    .suggest-edit-dialog__header p,
    .suggest-edit-dialog h3 {
      margin: 0;
    }

    .suggest-edit-dialog__eyebrow {
      margin-bottom: 4px !important;
      color: #64748b;
      font-size: 0.78rem;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .suggest-edit-dialog__close {
      width: 38px;
      height: 38px;
      border: 0;
      border-radius: 999px;
      background: color-mix(in srgb, CanvasText 8%, transparent);
      color: inherit;
      font-size: 26px;
      line-height: 1;
      cursor: pointer;
    }

    .suggest-edit-context {
      margin-bottom: 22px;
      padding: 16px;
      border: 1px solid color-mix(in srgb, CanvasText 14%, transparent);
      border-radius: 12px;
      background: color-mix(in srgb, CanvasText 4%, Canvas);
    }

    .suggest-edit-context__metadata {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
      margin: 0 0 14px;
    }

    .suggest-edit-context__metadata dt,
    .suggest-edit-context__label {
      margin: 0 0 3px;
      color: #64748b;
      font-size: 0.78rem;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }

    .suggest-edit-context__metadata dd {
      margin: 0;
      font-weight: 600;
    }

    .suggest-edit-context blockquote {
      margin: 0;
      padding-left: 12px;
      border-left: 4px solid #3b82f6;
      font-style: italic;
    }

    #suggest-edit-form {
      display: grid;
      gap: 18px;
    }

    .suggest-edit-field {
      display: grid;
      gap: 7px;
    }

    .suggest-edit-field label,
    #suggest-edit-placement-group legend {
      font-weight: 700;
    }

    .suggest-edit-field label span {
      font-weight: 400;
    }

    .suggest-edit-dialog input[type="text"],
    .suggest-edit-dialog select,
    .suggest-edit-dialog textarea {
      width: 100%;
      box-sizing: border-box;
      padding: 10px 12px;
      border: 1px solid color-mix(in srgb, CanvasText 24%, transparent);
      border-radius: 8px;
      background: Canvas;
      color: CanvasText;
      font: inherit;
    }

    .suggest-edit-dialog textarea {
      resize: vertical;
    }

    #suggest-edit-placement-group {
      display: grid;
      gap: 8px;
      margin: 0;
      padding: 14px;
      border: 1px solid color-mix(in srgb, CanvasText 14%, transparent);
      border-radius: 10px;
    }

    .suggest-edit-choice {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .suggest-edit-form-error {
      margin: 0;
      padding: 12px 14px;
      border: 1px solid #dc2626;
      border-radius: 8px;
      background: color-mix(in srgb, #dc2626 10%, Canvas);
      color: #dc2626;
      font-weight: 600;
    }

    .suggest-edit-actions,
    .suggest-edit-preview-actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      padding-top: 4px;
    }

    .suggest-edit-actions button,
    .suggest-edit-preview-actions button {
      padding: 10px 14px;
      border: 1px solid color-mix(in srgb, CanvasText 20%, transparent);
      border-radius: 8px;
      background: Canvas;
      color: CanvasText;
      font: 600 14px/1.3 system-ui, sans-serif;
      cursor: pointer;
    }

    .suggest-edit-actions .suggest-edit-primary,
    .suggest-edit-preview-actions .suggest-edit-primary {
      border-color: #2563eb;
      background: #2563eb;
      color: #ffffff;
    }

    .suggest-edit-actions button:disabled,
    .suggest-edit-preview-actions button:disabled {
      cursor: wait;
      opacity: 0.65;
    }

    #suggest-edit-preview-section {
      margin-top: 24px;
      padding-top: 20px;
      border-top: 1px solid color-mix(in srgb, CanvasText 14%, transparent);
    }

    #suggest-edit-preview-section h3 {
      margin: 2px 0 14px;
    }

    .suggest-edit-preview-notice {
      margin-bottom: 16px;
      padding: 12px 14px;
      border: 1px solid #60a5fa;
      border-radius: 10px;
      background: color-mix(in srgb, #3b82f6 10%, Canvas);
    }

    .suggest-edit-preview-notice strong {
      display: block;
      margin-bottom: 2px;
    }

    #suggest-edit-preview {
      display: grid;
      gap: 16px;
      padding: 18px;
      border: 1px solid color-mix(in srgb, CanvasText 14%, transparent);
      border-radius: 10px;
      background: color-mix(in srgb, CanvasText 4%, Canvas);
    }

    .suggest-edit-preview__title {
      margin: 0;
      font-size: 1.2rem;
    }

    .suggest-edit-preview__metadata {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
      margin: 0;
    }

    .suggest-edit-preview__metadata div,
    .suggest-edit-preview__field {
      min-width: 0;
    }

    .suggest-edit-preview__metadata dt,
    .suggest-edit-preview__label {
      margin: 0 0 4px;
      color: #64748b;
      font-size: 0.78rem;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }

    .suggest-edit-preview__metadata dd,
    .suggest-edit-preview__value {
      margin: 0;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
    }

    #suggest-edit-preview blockquote {
      margin: 0;
      padding-left: 12px;
      border-left: 4px solid #3b82f6;
      font-style: italic;
      white-space: pre-wrap;
    }

    .suggest-edit-preview__sources {
      margin: 0;
      padding-left: 20px;
    }

    .suggest-edit-preview__sources li + li {
      margin-top: 5px;
    }

    .suggest-edit-submission-result {
      margin-top: 16px;
      padding: 14px;
      border: 1px solid color-mix(in srgb, CanvasText 18%, transparent);
      border-radius: 10px;
      overflow-wrap: anywhere;
    }

    .suggest-edit-submission-result[data-state="pending"] {
      border-color: #60a5fa;
      background: color-mix(in srgb, #3b82f6 10%, Canvas);
    }

    .suggest-edit-submission-result[data-state="success"] {
      border-color: #16a34a;
      background: color-mix(in srgb, #16a34a 10%, Canvas);
    }

    .suggest-edit-submission-result[data-state="error"] {
      border-color: #dc2626;
      background: color-mix(in srgb, #dc2626 10%, Canvas);
    }

    .suggest-edit-submission-result strong {
      display: block;
      margin-bottom: 3px;
    }

    .suggest-edit-submission-result > span {
      display: block;
    }

    .suggest-edit-submission-result__link {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin-top: 12px;
      padding: 9px 13px;
      border: 1px solid currentColor;
      border-radius: 8px;
      color: inherit;
      font-weight: 700;
      text-decoration: none;
    }

    .suggest-edit-submission-result__link:hover,
    .suggest-edit-submission-result__link:focus-visible {
      text-decoration: underline;
    }

    .suggest-edit-preview-actions {
      margin-top: 16px;
    }

    @media (max-width: 560px) {
      .suggest-edit-dialog__body {
        padding: 18px;
      }

      .suggest-edit-context__metadata {
        grid-template-columns: 1fr;
      }

      .suggest-edit-preview__metadata {
        grid-template-columns: 1fr;
      }

      .suggest-edit-actions,
      .suggest-edit-preview-actions {
        flex-direction: column-reverse;
      }

      .suggest-edit-actions button,
      .suggest-edit-preview-actions button {
        width: 100%;
      }
    }
  `;

  document.head.append(styleElement);
  document.body.append(actionButton, dialog);

  /* ======================================================================== */
  /* FORM ELEMENT REFERENCES                                                  */
  /* ======================================================================== */

  const form = dialog.querySelector("#suggest-edit-form");
  const closeButton = dialog.querySelector("#suggest-edit-dialog-close");
  const cancelButton = dialog.querySelector("#suggest-edit-cancel");
  const previewButton = dialog.querySelector("#suggest-edit-preview-button");
  const formError = dialog.querySelector("#suggest-edit-form-error");
  const pageTitleOutput = dialog.querySelector("#suggest-edit-page-title");
  const sectionTitleOutput = dialog.querySelector(
    "#suggest-edit-section-title",
  );
  const selectedTextOutput = dialog.querySelector("#suggest-edit-selected-text");
  const operationSelect = dialog.querySelector("#suggest-edit-operation");
  const placementGroup = dialog.querySelector(
    "#suggest-edit-placement-group",
  );
  const titleInput = dialog.querySelector("#suggest-edit-title");
  const suggestedTextGroup = dialog.querySelector("#suggest-edit-text-group");
  const suggestedTextInput = dialog.querySelector("#suggest-edit-text");
  const rationaleInput = dialog.querySelector("#suggest-edit-rationale");
  const sourcesInput = dialog.querySelector("#suggest-edit-sources");
  const contributorNameInput = dialog.querySelector(
    "#suggest-edit-contributor-name",
  );
  const contributorAffiliationInput = dialog.querySelector(
    "#suggest-edit-contributor-affiliation",
  );
  const previewSection = dialog.querySelector(
    "#suggest-edit-preview-section",
  );
  const previewOutput = dialog.querySelector("#suggest-edit-preview");
  const submissionResult = dialog.querySelector(
    "#suggest-edit-submission-result",
  );
  const backToFormButton = dialog.querySelector(
    "#suggest-edit-back-to-form",
  );
  const submitSuggestionButton = dialog.querySelector(
    "#suggest-edit-submit-suggestion",
  );

  /* ======================================================================== */
  /* TEXT AND EDITORIAL ANCHOR UTILITIES                                      */
  /* ======================================================================== */

  function normalizeText(text) {
    return text.replace(/\s+/g, " ").trim();
  }

  // HTML block boundaries are not always represented by whitespace in
  // Range.toString(). For example, the end of one paragraph and the start of
  // the next one may otherwise become "another.Surface".
  const contextBoundaryElementNames = new Set([
    "ADDRESS",
    "ARTICLE",
    "ASIDE",
    "BLOCKQUOTE",
    "DD",
    "DETAILS",
    "DIALOG",
    "DIV",
    "DL",
    "DT",
    "FIELDSET",
    "FIGCAPTION",
    "FIGURE",
    "FOOTER",
    "FORM",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "HEADER",
    "HGROUP",
    "HR",
    "LI",
    "MAIN",
    "NAV",
    "OL",
    "P",
    "PRE",
    "SECTION",
    "TABLE",
    "TBODY",
    "TD",
    "TFOOT",
    "TH",
    "THEAD",
    "TR",
    "UL",
  ]);

  function extractContextText(range) {
    const rangeContents = range.cloneContents();
    const textParts = [];

    function appendBoundary() {
      if (
        textParts.length > 0 &&
        !/\s$/.test(textParts[textParts.length - 1])
      ) {
        textParts.push(" ");
      }
    }

    function visitNode(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        textParts.push(node.nodeValue || "");
        return;
      }

      if (
        node.nodeType !== Node.ELEMENT_NODE &&
        node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE
      ) {
        return;
      }

      const isLineBreak =
        node.nodeType === Node.ELEMENT_NODE &&
        node.nodeName === "BR";

      const isBlockBoundary =
        node.nodeType === Node.ELEMENT_NODE &&
        contextBoundaryElementNames.has(node.nodeName);

      if (isLineBreak || isBlockBoundary) {
        appendBoundary();
      }

      for (const childNode of node.childNodes) {
        visitNode(childNode);
      }

      if (isBlockBoundary) {
        appendBoundary();
      }
    }

    visitNode(rangeContents);

    return normalizeText(textParts.join(""));
  }

  function cloneSerializable(value) {
    return JSON.parse(JSON.stringify(value));
  }

  /* ======================================================================== */
  /* SOURCE PATH RESOLUTION                                                   */
  /* ======================================================================== */

  function normalizeRoutePath(routePath) {
    let normalizedPath = decodeURIComponent(routePath || "/")
      .split(/[?#]/, 1)[0]
      .replace(/\/{2,}/g, "/");

    if (!normalizedPath.startsWith("/")) {
      normalizedPath = `/${normalizedPath}`;
    }

    if (normalizedPath.length > 1) {
      normalizedPath = normalizedPath.replace(/\/+$/, "");
    }

    return normalizedPath;
  }

  function createSlugRouteCandidates(slug) {
    const normalizedSlug = String(slug || "")
      .replace(/^\/+|\/+$/g, "")
      .replace(/\.(?:md|ipynb)$/i, "");

    const candidates = new Set();

    if (!normalizedSlug) {
      candidates.add("/");
      return candidates;
    }

    candidates.add(normalizeRoutePath(`/${normalizedSlug}`));

    if (normalizedSlug === "index") {
      candidates.add("/");
    } else if (normalizedSlug.endsWith("/index")) {
      candidates.add(
        normalizeRoutePath(
          `/${normalizedSlug.slice(0, -"/index".length)}`,
        ),
      );
    }

    return candidates;
  }

  function createSourceRouteCandidates(sourcePath) {
    const portableSourcePath = String(sourcePath || "")
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .replace(/\.(?:md|ipynb)$/i, "");

    // Jupyter Book 2 converts underscores to hyphens in public page routes.
    const publicSlug = portableSourcePath
      .split("/")
      .map((segment) => segment.replaceAll("_", "-"))
      .join("/");

    return createSlugRouteCandidates(publicSlug);
  }

  function getCurrentRemixPage() {
    const loaderData = window.__remixContext?.state?.loaderData;

    if (!loaderData || typeof loaderData !== "object") {
      return null;
    }

    const currentRoute = normalizeRoutePath(window.location.pathname);

    for (const routeData of Object.values(loaderData)) {
      const page = routeData?.page;

      if (
        typeof page?.slug === "string" &&
        routeMatchesCurrentPage(
          createSlugRouteCandidates(page.slug),
          currentRoute,
        )
      ) {
        return page;
      }
    }

    return null;
  }

  function getExpandedTableOfContents() {
    return (
      window.__remixContext?.state?.loaderData?.root?.config?.projects?.[0]
        ?.toc ?? null
    );
  }

  function collectSourceFiles(value, sourceFiles, visitedObjects) {
    if (Array.isArray(value)) {
      for (const item of value) {
        collectSourceFiles(item, sourceFiles, visitedObjects);
      }

      return;
    }

    if (
      value === null ||
      typeof value !== "object" ||
      visitedObjects.has(value)
    ) {
      return;
    }

    visitedObjects.add(value);

    if (typeof value.file === "string") {
      sourceFiles.add(
        value.file.replace(/\\/g, "/").replace(/^\/+/, ""),
      );
    }

    for (const childValue of Object.values(value)) {
      collectSourceFiles(childValue, sourceFiles, visitedObjects);
    }
  }

  function routeMatchesCurrentPage(routeCandidates, currentRoute) {
    return routeCandidates.has(currentRoute);
  }

  function resolveSourcePath() {
    const currentRoute = normalizeRoutePath(window.location.pathname);
    const remixPage = getCurrentRemixPage();

    // Remix may retain the data of the page that originally loaded the app
    // after client-side navigation. Trust page.location only when page.slug
    // still corresponds to the current browser route.
    if (
      typeof remixPage?.location === "string" &&
      typeof remixPage?.slug === "string" &&
      routeMatchesCurrentPage(
        createSlugRouteCandidates(remixPage.slug),
        currentRoute,
      )
    ) {
      return remixPage.location.replace(/\\/g, "/").replace(/^\/+/, "");
    }

    const tableOfContents = getExpandedTableOfContents();

    if (!tableOfContents) {
      throw new Error(
        "The expanded MyST table of contents is not available.",
      );
    }

    const sourceFiles = new Set();
    collectSourceFiles(tableOfContents, sourceFiles, new WeakSet());

    const matchingSourceFiles = [...sourceFiles].filter((sourcePath) =>
      routeMatchesCurrentPage(
        createSourceRouteCandidates(sourcePath),
        currentRoute,
      ),
    );

    if (matchingSourceFiles.length === 1) {
      return matchingSourceFiles[0];
    }

    if (matchingSourceFiles.length === 0) {
      throw new Error(
        `No MyST source file matches the current route: ${currentRoute}`,
      );
    }

    throw new Error(
      `Several MyST source files match ${currentRoute}: ${matchingSourceFiles.join(
        ", ",
      )}`,
    );
  }

  function normalizeSourceFilePath(sourcePath) {
    return String(sourcePath || "")
      .replace(/\\/g, "/")
      .replace(/^\/+/, "");
  }

  function pageMatchesSourcePath(page, sourcePath) {
    return (
      typeof page?.location === "string" &&
      normalizeSourceFilePath(page.location) ===
        normalizeSourceFilePath(sourcePath)
    );
  }

  function extractPageRevision(page, sourcePath) {
    if (!pageMatchesSourcePath(page, sourcePath)) {
      return null;
    }

    if (
      typeof page.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/i.test(page.sha256)
    ) {
      return null;
    }

    return page.sha256.toLowerCase();
  }

  /**
   * Ask the current MyST/Remix route for its page data.
   *
   * This remains reliable after client-side navigation, even when the global
   * Remix bootstrap object still describes the page that initially loaded the
   * application.
   */
  async function fetchCurrentRoutePage(sourcePath) {
    const currentRoute = normalizeRoutePath(window.location.pathname);
    const routeIds =
      currentRoute === "/"
        ? ["routes/_index", "routes/$"]
        : ["routes/$", "routes/_index"];

    for (const routeId of routeIds) {
      const routeDataUrl = new URL(window.location.href);
      routeDataUrl.hash = "";
      routeDataUrl.searchParams.set("_data", routeId);

      let response;

      try {
        response = await fetch(routeDataUrl, {
          credentials: "same-origin",
          cache: "no-store",
          headers: {
            Accept: "application/json",
          },
        });
      } catch {
        continue;
      }

      if (!response.ok) {
        continue;
      }

      let routeData;

      try {
        routeData = await response.json();
      } catch {
        continue;
      }

      const page = routeData?.page ?? routeData?.data?.page ?? null;

      if (pageMatchesSourcePath(page, sourcePath)) {
        return page;
      }
    }

    return null;
  }

  async function resolvePageRevision(sourcePath) {
    const revisionFromLoadedPage = extractPageRevision(
      getCurrentRemixPage(),
      sourcePath,
    );

    if (revisionFromLoadedPage) {
      return revisionFromLoadedPage;
    }

    const fetchedPage = await fetchCurrentRoutePage(sourcePath);
    const fetchedRevision = extractPageRevision(fetchedPage, sourcePath);

    if (fetchedRevision) {
      return fetchedRevision;
    }

    throw new Error(
      `Unable to determine the MyST revision of ${sourcePath}.`,
    );
  }

  function getPageTitle() {
    const mainContent = getMainContent();
    const pageHeading = mainContent.querySelector("h1");
    return normalizeText(pageHeading?.textContent || document.title);
  }

  function getNearestSectionHeading(range) {
    const mainContent = getMainContent();
    const headings = mainContent.querySelectorAll("h1, h2, h3, h4, h5, h6");
    const selectionStartNode = range.startContainer;
    let nearestHeading = null;

    for (const heading of headings) {
      if (heading.contains(selectionStartNode)) {
        nearestHeading = heading;
        break;
      }

      const relativePosition =
        heading.compareDocumentPosition(selectionStartNode);

      if (relativePosition & Node.DOCUMENT_POSITION_FOLLOWING) {
        nearestHeading = heading;
        continue;
      }

      if (relativePosition & Node.DOCUMENT_POSITION_PRECEDING) {
        break;
      }
    }

    return nearestHeading;
  }

  function getSelectionContext(range) {
    const mainContent = getMainContent();

    if (!mainContent) {
      throw new Error("The current main page content was not found.");
    }

    const precedingRange = document.createRange();
    precedingRange.selectNodeContents(mainContent);
    precedingRange.setEnd(range.startContainer, range.startOffset);

    const followingRange = document.createRange();
    followingRange.selectNodeContents(mainContent);
    followingRange.setStart(range.endContainer, range.endOffset);

    const precedingText = extractContextText(precedingRange);
    const followingText = extractContextText(followingRange);

    return {
      prefix: precedingText.slice(-contextCharacterLimit),
      suffix: followingText.slice(0, contextCharacterLimit),
    };
  }

  function createEditorialAnchor(range, selectedText) {
    const sectionHeading = getNearestSectionHeading(range);
    const context = getSelectionContext(range);

    return {
      source: {
        pageTitle: getPageTitle(),
        pageUrl: window.location.href,
        sourcePath: resolveSourcePath(),
        pageRevision: null,
      },
      section: {
        title: sectionHeading
          ? normalizeText(sectionHeading.textContent)
          : getPageTitle(),
        id: sectionHeading?.id || null,
        level: sectionHeading?.tagName.toLowerCase() || null,
      },
      selector: {
        type: "TextQuoteSelector",
        exact: selectedText,
        prefix: context.prefix,
        suffix: context.suffix,
      },
    };
  }

  function getSelectedText() {
    const mainContent = getMainContent();
    const selection = window.getSelection();

    if (
      !mainContent ||
      !selection ||
      selection.isCollapsed ||
      selection.rangeCount === 0
    ) {
      return null;
    }

    const selectedText = normalizeText(selection.toString());

    if (!selectedText) {
      return null;
    }

    const range = selection.getRangeAt(0);
    const commonAncestor = range.commonAncestorContainer;
    const commonElement =
      commonAncestor.nodeType === Node.ELEMENT_NODE
        ? commonAncestor
        : commonAncestor.parentElement;

    if (!commonElement || !mainContent.contains(commonElement)) {
      return null;
    }

    const clonedRange = range.cloneRange();

    return {
      text: selectedText,
      range: clonedRange,
      anchor: createEditorialAnchor(clonedRange, selectedText),
    };
  }

  /* ======================================================================== */
  /* FLOATING ACTION BUTTON                                                   */
  /* ======================================================================== */

  function hideActionButton(options = {}) {
    const { clearSelection = true } = options;

    actionButton.hidden = true;

    if (clearSelection) {
      capturedSelection = null;
    }
  }

  function positionActionButton(range) {
    const selectionRectangle = range.getBoundingClientRect();

    if (selectionRectangle.width === 0 && selectionRectangle.height === 0) {
      hideActionButton();
      return;
    }

    actionButton.hidden = false;

    const buttonRectangle = actionButton.getBoundingClientRect();
    const preferredLeft =
      selectionRectangle.left +
      selectionRectangle.width / 2 -
      buttonRectangle.width / 2;

    const safeLeft = Math.min(
      Math.max(preferredLeft, 12),
      window.innerWidth - buttonRectangle.width - 12,
    );

    const safeTop = Math.min(
      selectionRectangle.bottom + 10,
      window.innerHeight - buttonRectangle.height - 12,
    );

    actionButton.style.left = `${safeLeft}px`;
    actionButton.style.top = `${safeTop}px`;
  }

  function handlePointerSelection(event) {
    // Interactions with the prototype interface must not be mistaken for new
    // selections in the scientific content.
    if (
      actionButton.contains(event.target) ||
      dialog.contains(event.target)
    ) {
      return;
    }

    window.setTimeout(() => {
      let selectionData;

      try {
        selectionData = getSelectedText();
      } catch (error) {
        hideActionButton();
        console.error(
          "[Suggest an edit] Unable to resolve the source page.",
          error,
        );
        return;
      }

      if (!selectionData) {
        hideActionButton();
        return;
      }

      capturedSelection = selectionData;
      positionActionButton(selectionData.range);

      console.info("[Suggest an edit] Valid selection detected.", {
        selectedText: selectionData.text,
      });
    }, 0);
  }

  function handleActionButtonMouseDown(event) {
    // Preserve the selected passage while pressing the floating button.
    event.preventDefault();
  }

  function handleActionButtonClick() {
    if (!capturedSelection) {
      return;
    }

    activeAnchor = cloneSerializable(capturedSelection.anchor);
    lastDraft = null;

    form.reset();
    operationSelect.value = "add";
    updateOperationFields();
    hidePreview();
    hideFormError();

    pageTitleOutput.textContent = activeAnchor.source.pageTitle;
    sectionTitleOutput.textContent = activeAnchor.section.title;
    selectedTextOutput.textContent = activeAnchor.selector.exact;

    hideActionButton({ clearSelection: false });
    window.getSelection()?.removeAllRanges();

    if (!dialog.open) {
      dialog.showModal();
    }

    titleInput.focus();
  }

  /* ======================================================================== */
  /* FORM BEHAVIOUR                                                           */
  /* ======================================================================== */

  function updateOperationFields() {
    const isAddition = operationSelect.value === "add";

    placementGroup.hidden = !isAddition;
    placementGroup.disabled = !isAddition;
    suggestedTextGroup.hidden = !isAddition;
    suggestedTextInput.disabled = !isAddition;
    suggestedTextInput.required = isAddition;

    if (!isAddition) {
      suggestedTextInput.value = "";
    }
  }

  function hidePreview() {
    previewSection.hidden = true;
    previewOutput.replaceChildren();
    resetSubmissionState();
  }

  function resetSubmissionState() {
    submissionResult.hidden = true;
    submissionResult.removeAttribute("data-state");
    submissionResult.replaceChildren();
    backToFormButton.disabled = false;
    submitSuggestionButton.disabled = false;
    submitSuggestionButton.textContent = "Submit suggestion";
  }

  function getSafeGitHubIssueUrl(candidateUrl) {
    if (typeof candidateUrl !== "string" || !candidateUrl.trim()) {
      return null;
    }

    try {
      const issueUrl = new URL(candidateUrl);
      const isSecureGitHubUrl =
        issueUrl.protocol === "https:" &&
        issueUrl.hostname === "github.com";
      const isIssuePath =
        /^\/[^/]+\/[^/]+\/issues\/\d+\/?$/.test(issueUrl.pathname);

      if (!isSecureGitHubUrl || !isIssuePath) {
        return null;
      }

      return issueUrl.href;
    } catch {
      return null;
    }
  }

  function showSubmissionResult(
    state,
    title,
    message,
    { publicDiscussionUrl = null } = {},
  ) {
    const resultTitle = document.createElement("strong");
    const resultMessage = document.createElement("span");

    resultTitle.textContent = title;
    resultMessage.textContent = message;

    submissionResult.replaceChildren(resultTitle, resultMessage);

    const safePublicDiscussionUrl = getSafeGitHubIssueUrl(
      publicDiscussionUrl,
    );

    if (safePublicDiscussionUrl) {
      const publicDiscussionLink = document.createElement("a");

      publicDiscussionLink.className =
        "suggest-edit-submission-result__link";
      publicDiscussionLink.href = safePublicDiscussionUrl;
      publicDiscussionLink.target = "_blank";
      publicDiscussionLink.rel = "noopener noreferrer";
      publicDiscussionLink.textContent = "View public discussion";

      submissionResult.append(publicDiscussionLink);
    }

    submissionResult.dataset.state = state;
    submissionResult.hidden = false;
  }

  function hideFormError() {
    formError.hidden = true;
    formError.textContent = "";
  }

  function showFormError(message) {
    formError.textContent = message;
    formError.hidden = false;
  }

  function parseSources(value) {
    return value
      .split(/\r?\n/)
      .map((source) => source.trim())
      .filter(Boolean);
  }

  /**
   * Collect the optional public identity supplied by the contributor.
   *
   * When both fields are empty, return null so an anonymous suggestion does
   * not contain a meaningless empty contributor object.
   */
  function createContributorInformation() {
    const displayName = contributorNameInput.value.trim();
    const affiliation = contributorAffiliationInput.value.trim();

    if (!displayName && !affiliation) {
      return null;
    }

    const contributor = {};

    if (displayName) {
      contributor.displayName = displayName;
    }

    if (affiliation) {
      contributor.affiliation = affiliation;
    }

    return contributor;
  }

  async function createSuggestionDraft() {
    const operation = operationSelect.value;
    const formData = new FormData(form);
    const contributor = createContributorInformation();
    const target = cloneSerializable(activeAnchor);

    target.source.pageRevision = await resolvePageRevision(
      target.source.sourcePath,
    );

    return {
      schemaVersion: 1,
      type: "content-suggestion",
      status: "draft",
      createdAt: new Date().toISOString(),
      operation,
      placement: operation === "add" ? formData.get("placement") : null,
      title: titleInput.value.trim(),
      ...(contributor ? { contributor } : {}),
      target,
      body: {
        suggestedText:
          operation === "add" ? suggestedTextInput.value.trim() : null,
        rationale: rationaleInput.value.trim(),
        sources: parseSources(sourcesInput.value),
      },
    };
  }

  /**
   * Create one labelled text field for the human-readable preview.
   * textContent is used deliberately so contributor-supplied text is never
   * interpreted as HTML.
   */
  function createPreviewField(label, value, { quote = false } = {}) {
    const field = document.createElement("section");
    field.className = "suggest-edit-preview__field";

    const fieldLabel = document.createElement("p");
    fieldLabel.className = "suggest-edit-preview__label";
    fieldLabel.textContent = label;

    const fieldValue = document.createElement(quote ? "blockquote" : "p");
    fieldValue.className = "suggest-edit-preview__value";
    fieldValue.textContent = value;

    field.append(fieldLabel, fieldValue);

    return field;
  }

  function createPreviewMetadataItem(label, value) {
    const item = document.createElement("div");
    const term = document.createElement("dt");
    const description = document.createElement("dd");

    term.textContent = label;
    description.textContent = value;
    item.append(term, description);

    return item;
  }

  function describeOperation(draft) {
    if (draft.operation === "delete") {
      return "Delete the selected passage";
    }

    return `Add text ${draft.placement} the selected passage`;
  }

  function describeContributor(contributor) {
    if (!contributor) {
      return "Anonymous contributor";
    }

    const identityParts = [
      contributor.displayName,
      contributor.affiliation,
    ].filter(Boolean);

    return identityParts.join(" — ");
  }

  /**
   * Render a reader-friendly summary while keeping the complete JSON draft
   * available internally through getLastDraft().
   */
  function renderHumanPreview(draft) {
    previewOutput.replaceChildren();

    const previewTitle = document.createElement("h4");
    previewTitle.className = "suggest-edit-preview__title";
    previewTitle.textContent = draft.title;

    const metadata = document.createElement("dl");
    metadata.className = "suggest-edit-preview__metadata";
    metadata.append(
      createPreviewMetadataItem("Page", draft.target.source.pageTitle),
      createPreviewMetadataItem("Section", draft.target.section.title),
      createPreviewMetadataItem("Proposed action", describeOperation(draft)),
      createPreviewMetadataItem(
        "Contributor",
        describeContributor(draft.contributor),
      ),
    );

    previewOutput.append(
      previewTitle,
      metadata,
      createPreviewField(
        "Selected passage",
        draft.target.selector.exact,
        { quote: true },
      ),
    );

    if (draft.operation === "add") {
      previewOutput.append(
        createPreviewField("Suggested text", draft.body.suggestedText),
      );
    }

    previewOutput.append(
      createPreviewField("Why this change?", draft.body.rationale),
    );

    const sourcesField = document.createElement("section");
    sourcesField.className = "suggest-edit-preview__field";

    const sourcesLabel = document.createElement("p");
    sourcesLabel.className = "suggest-edit-preview__label";
    sourcesLabel.textContent = "Sources";
    sourcesField.append(sourcesLabel);

    if (draft.body.sources.length === 0) {
      const noSources = document.createElement("p");
      noSources.className = "suggest-edit-preview__value";
      noSources.textContent = "No sources provided.";
      sourcesField.append(noSources);
    } else {
      const sourcesList = document.createElement("ul");
      sourcesList.className = "suggest-edit-preview__sources";

      for (const source of draft.body.sources) {
        const sourceItem = document.createElement("li");
        sourceItem.textContent = source;
        sourcesList.append(sourceItem);
      }

      sourcesField.append(sourcesList);
    }

    previewOutput.append(sourcesField);
  }

  async function readSubmissionResponse(response) {
    const responseText = await response.text();

    if (!responseText.trim()) {
      throw new Error("The storage server returned an empty response.");
    }

    try {
      return JSON.parse(responseText);
    } catch {
      throw new Error("The storage server returned invalid JSON.");
    }
  }

  function handleBackToForm() {
    hidePreview();
    form.scrollIntoView({ behavior: "smooth", block: "start" });
    titleInput.focus({ preventScroll: true });
  }

  async function handleSuggestionSubmission() {
    if (!lastDraft) {
      showSubmissionResult(
        "error",
        "Nothing to submit.",
        "Prepare a suggestion preview before submitting it.",
      );
      return;
    }

    showSubmissionResult(
      "pending",
      "Submitting suggestion…",
      "The proposal is being validated and stored.",
    );
    backToFormButton.disabled = true;
    submitSuggestionButton.disabled = true;
    submitSuggestionButton.textContent = "Submitting…";
    previewButton.disabled = true;

    try {
      const response = await fetch(suggestionSubmissionUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(lastDraft),
      });
      const responseBody = await readSubmissionResponse(response);

      if (!response.ok) {
        throw new Error(
          responseBody.message ||
            `The storage server rejected the request (${response.status}).`,
        );
      }

      if (
        responseBody.persisted !== true ||
        typeof responseBody.id !== "string" ||
        typeof responseBody.submittedAt !== "string"
      ) {
        throw new Error(
          "The storage server did not confirm the saved suggestion.",
        );
      }

      const delivery = responseBody.delivery;
      const wasPublishedToGitHub =
        delivery?.status === "delivered" &&
        delivery?.provider === "github";

      if (wasPublishedToGitHub) {
        showSubmissionResult(
          "success",
          "Suggestion published successfully.",
          `Reference: ${responseBody.id}. The proposal is now available for public discussion on GitHub.`,
          {
            publicDiscussionUrl:
              delivery.issueUrl || responseBody.issueUrl,
          },
        );
      } else {
        showSubmissionResult(
          "success",
          "Suggestion submitted successfully.",
          `Reference: ${responseBody.id}. The proposal has been stored for editorial review.`,
        );
      }
      submitSuggestionButton.textContent = "Submitted";
      backToFormButton.disabled = false;

      console.info(
        "[Suggest an edit] Suggestion stored successfully.",
        responseBody,
      );
    } catch (error) {
      showSubmissionResult(
        "error",
        "The suggestion could not be submitted.",
        error.message || "No data was confirmed as saved.",
      );
      backToFormButton.disabled = false;
      submitSuggestionButton.disabled = false;
      submitSuggestionButton.textContent = "Try again";

      console.error(
        "[Suggest an edit] Suggestion submission failed.",
        error,
      );
    } finally {
      previewButton.disabled = false;
    }
  }

  function handleOperationChange() {
    updateOperationFields();
    hidePreview();
    hideFormError();
  }

  function handleFormInput() {
    hidePreview();
    hideFormError();
  }

  async function handleFormSubmit(event) {
    event.preventDefault();

    if (!activeAnchor) {
      console.error("[Suggest an edit] No editorial anchor is available.");
      return;
    }

    hideFormError();
    previewButton.disabled = true;
    previewButton.textContent = "Preparing preview…";

    try {
      lastDraft = await createSuggestionDraft();
      renderHumanPreview(lastDraft);
      previewSection.hidden = false;
      previewSection.scrollIntoView({ behavior: "smooth", block: "nearest" });

      console.info("[Suggest an edit] Draft suggestion prepared.", lastDraft);
    } catch (error) {
      lastDraft = null;
      hidePreview();
      showFormError(
        "The page revision could not be determined. Please reload the page and try again.",
      );

      console.error(
        "[Suggest an edit] Unable to prepare the suggestion draft.",
        error,
      );
    } finally {
      previewButton.disabled = false;
      previewButton.textContent = "Preview suggestion";
    }
  }

  function closeDialog(returnValue = "cancel") {
    if (dialog.open) {
      dialog.close(returnValue);
    }
  }

  function handleDialogClose() {
    activeAnchor = null;
    capturedSelection = null;
    form.reset();
    updateOperationFields();
    hidePreview();
    hideFormError();
  }

  function handleWindowReposition() {
    if (!dialog.open) {
      hideActionButton();
    }
  }

  /* ======================================================================== */
  /* EVENT REGISTRATION                                                       */
  /* ======================================================================== */

  // Listen on document rather than on the current <main>. This listener
  // survives Remix replacing the article during client-side navigation.
  document.addEventListener("mouseup", handlePointerSelection);
  actionButton.addEventListener("mousedown", handleActionButtonMouseDown);
  actionButton.addEventListener("click", handleActionButtonClick);
  operationSelect.addEventListener("change", handleOperationChange);
  form.addEventListener("input", handleFormInput);
  form.addEventListener("submit", handleFormSubmit);
  backToFormButton.addEventListener("click", handleBackToForm);
  submitSuggestionButton.addEventListener(
    "click",
    handleSuggestionSubmission,
  );
  closeButton.addEventListener("click", () => closeDialog("close"));
  cancelButton.addEventListener("click", () => closeDialog("cancel"));
  dialog.addEventListener("close", handleDialogClose);
  window.addEventListener("scroll", handleWindowReposition, true);
  window.addEventListener("resize", handleWindowReposition);

  /* ======================================================================== */
  /* DEVELOPMENT API AND CLEANUP                                              */
  /* ======================================================================== */

  window.suggestEditPrototype = {
    getSourcePath() {
      return resolveSourcePath();
    },

    getLastDraft() {
      return lastDraft ? cloneSerializable(lastDraft) : null;
    },

    destroy() {
      document.removeEventListener("mouseup", handlePointerSelection);
      actionButton.removeEventListener("mousedown", handleActionButtonMouseDown);
      actionButton.removeEventListener("click", handleActionButtonClick);
      operationSelect.removeEventListener("change", handleOperationChange);
      form.removeEventListener("input", handleFormInput);
      form.removeEventListener("submit", handleFormSubmit);
      backToFormButton.removeEventListener("click", handleBackToForm);
      submitSuggestionButton.removeEventListener(
        "click",
        handleSuggestionSubmission,
      );
      dialog.removeEventListener("close", handleDialogClose);
      window.removeEventListener("scroll", handleWindowReposition, true);
      window.removeEventListener("resize", handleWindowReposition);

      if (dialog.open) {
        dialog.close("destroy");
      }

      actionButton.remove();
      dialog.remove();
      styleElement.remove();
      delete window.suggestEditPrototype;

      console.info("[Suggest an edit] Previous prototype removed.");
    },
  };

  console.info("[Suggest an edit] Form prototype loaded.");
}

/* ========================================================================== */
/* MYST ANYWIDGET ENTRY POINT                                                 */
/* ========================================================================== */

function render({ el }) {
  // Start the global suggestion interface when MyST mounts the site footer.
  initializeSuggestEdit();

  // Leave only an invisible diagnostic marker inside the widget itself.
  const marker = document.createElement("span");
  marker.hidden = true;
  marker.setAttribute("data-suggest-edit-loader", "active");
  el.appendChild(marker);

  console.info("[Suggest an edit] Automatic MyST widget active.");

  // MyST calls this cleanup function when the widget is removed, for example
  // during client-side navigation. A newly mounted widget will initialize a
  // fresh interface for the next page.
  return () => {
    window.suggestEditPrototype?.destroy?.();
  };
}

export default {
  render,
};
