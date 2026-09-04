import validateSuggestion from "./generated/validate-suggestion.mjs";

import {
  formatSuggestionAsGitHubIssue,
} from "../../lib/content-suggestions/github-issue-formatter.mjs";

import {
  runD1SuggestionRetryCycle,
} from "./suggestion-retry-service.mjs";

import {
  createGitHubAppIssueDelivery,
} from "./github-api-client.mjs";

import {
  deliverPendingSuggestion,
} from "./suggestion-delivery-service.mjs";

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

function githubDeliveryIsEnabled(env) {
  return env.GITHUB_DELIVERY_ENABLED === "true";
}

function isAllowedOrigin(origin, env) {
  if (!origin) return false;

  if (
    env.ENVIRONMENT === "local" &&
    /^http:\/\/(?:localhost|127\.0\.0\.1):\d+$/u.test(origin)
  ) {
    return true;
  }

  const configuredOrigin =
    typeof env.ALLOWED_ORIGIN === "string"
      ? env.ALLOWED_ORIGIN.trim()
      : "";

  return configuredOrigin !== "" && origin === configuredOrigin;
}

function createCorsHeaders(origin) {
  const headers = new Headers();

  if (!origin) return headers;

  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Access-Control-Max-Age", "86400");
  headers.set("Vary", "Origin");

  return headers;
}

function jsonResponse(payload, status = 200, additionalHeaders = undefined) {
  const headers = new Headers(additionalHeaders);
  headers.set("Content-Type", JSON_CONTENT_TYPE);
  headers.set("Cache-Control", "no-store");

  return new Response(`${JSON.stringify(payload, null, 2)}\n`, {
    status,
    headers,
  });
}

function formatValidationErrors(errors = []) {
  return errors.map((error) => ({
    path: error.instancePath || "/",
    keyword: error.keyword,
    message: error.message,
    params: error.params,
  }));
}

async function persistSuggestion(env, suggestion) {
  const id = crypto.randomUUID();
  const submittedAt = new Date().toISOString();
  const storedRecord = {
    recordVersion: 2,
    id,
    status: "open",
    submittedAt,
    suggestion,
    delivery: {
      status: "pending",
    },
  };

  const result = await env.DB.prepare(`
    INSERT INTO suggestions (
      id,
      record_version,
      schema_version,
      moderation_status,
      submitted_at,
      suggestion_json,
      delivery_status,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    storedRecord.id,
    storedRecord.recordVersion,
    suggestion.schemaVersion,
    storedRecord.status,
    storedRecord.submittedAt,
    JSON.stringify(storedRecord.suggestion),
    storedRecord.delivery.status,
    storedRecord.submittedAt,
    storedRecord.submittedAt,
  ).run();

  if (!result.success) {
    throw new Error("D1 did not confirm the suggestion insertion.");
  }

  return storedRecord;
}

async function handleScheduledRecovery(controller, env) {
  const scheduledTime = Number.isFinite(controller.scheduledTime)
    ? new Date(controller.scheduledTime)
    : new Date();

  if (!githubDeliveryIsEnabled(env)) {
    console.info("[Suggestion retry] GitHub delivery is disabled.", {
      cron: controller.cron ?? null,
      scheduledTime: scheduledTime.toISOString(),
      environment: env.ENVIRONMENT ?? "unknown",
    });

    return;
  }

  const deliverIssue = createGitHubAppIssueDelivery({ env });
  const summary = await runD1SuggestionRetryCycle({
    db: env.DB,
    deliverIssue,
    now: scheduledTime,
  });

  console.info("[Suggestion retry] Scheduled cycle completed.", {
    cron: controller.cron ?? null,
    scheduledTime: scheduledTime.toISOString(),
    selected: summary.selected,
    delivered: summary.delivered,
    reused: summary.reused,
    failed: summary.failed,
    needsAttention: summary.needsAttention,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const originIsAllowed = isAllowedOrigin(origin, env);
    const corsHeaders = originIsAllowed
      ? createCorsHeaders(origin)
      : new Headers();

    if (origin && !originIsAllowed) {
      return jsonResponse(
        {
          error: "origin_forbidden",
          message: "This origin is not allowed to use the suggestion API.",
        },
        403,
      );
    }

    if (request.method === "OPTIONS" && url.pathname === "/api/suggestions") {
      if (!origin) {
        return jsonResponse(
          {
            error: "missing_origin",
            message: "CORS preflight requests must provide an Origin header.",
          },
          403,
        );
      }

      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse(
        {
          status: "ok",
          service: "architectural-geometry-suggestions",
          environment: env.ENVIRONMENT,
          storage: "d1",
          issueFormatting: "enabled",
          githubAuthentication: "github-app",
          githubDelivery: githubDeliveryIsEnabled(env)
            ? "enabled"
            : "disabled",
          scheduledRecovery: "configured",
        },
        200,
        corsHeaders,
      );
    }

    if (request.method === "POST" && url.pathname === "/api/suggestions") {
      const contentType = request.headers.get("Content-Type") ?? "";

      if (!contentType.toLowerCase().startsWith("application/json")) {
        return jsonResponse(
          {
            error: "unsupported_media_type",
            message: "The request body must use application/json.",
          },
          415,
          corsHeaders,
        );
      }

      let suggestion;

      try {
        suggestion = await request.json();
      } catch {
        return jsonResponse(
          {
            error: "invalid_json",
            message: "The request body is not valid JSON.",
          },
          400,
          corsHeaders,
        );
      }

      if (!validateSuggestion(suggestion)) {
        return jsonResponse(
          {
            error: "invalid_suggestion",
            message: "The suggestion does not satisfy the content schema.",
            details: formatValidationErrors(validateSuggestion.errors),
          },
          422,
          corsHeaders,
        );
      }

      let storedRecord;

      try {
        storedRecord = await persistSuggestion(env, suggestion);
      } catch (error) {
        console.error("Unable to persist the suggestion in D1.", error);

        return jsonResponse(
          {
            error: "storage_failure",
            message: "The suggestion could not be stored.",
          },
          500,
          corsHeaders,
        );
      }

      let issuePreview;

      try {
        issuePreview = formatSuggestionAsGitHubIssue(storedRecord);
      } catch (error) {
        console.error("Unable to format the GitHub Issue preview.", error);

        return jsonResponse(
          {
            error: "issue_formatting_failure",
            message:
              `The suggestion was stored with reference ${storedRecord.id}, ` +
              "but its GitHub Issue preview could not be generated.",
            persisted: true,
            id: storedRecord.id,
            status: storedRecord.status,
            submittedAt: storedRecord.submittedAt,
            delivery: storedRecord.delivery,
            issuePreview: null,
          },
          500,
          corsHeaders,
        );
      }

      let delivery = storedRecord.delivery;

      if (githubDeliveryIsEnabled(env)) {
        try {
          const deliverIssue = createGitHubAppIssueDelivery({ env });

          delivery = await deliverPendingSuggestion({
            db: env.DB,
            storedRecord,
            deliverIssue,
          });
        } catch (error) {
          console.error(
            "Unable to record the GitHub delivery attempt in D1.",
            error,
          );

          return jsonResponse(
            {
              error: "delivery_tracking_failure",
              message:
                `The suggestion was stored with reference ${storedRecord.id}, ` +
                "but its GitHub delivery state could not be recorded.",
              persisted: true,
              id: storedRecord.id,
              status: storedRecord.status,
              submittedAt: storedRecord.submittedAt,
              delivery: null,
              issuePreview,
            },
            500,
            corsHeaders,
          );
        }
      }

      return jsonResponse(
        {
          persisted: true,
          id: storedRecord.id,
          status: storedRecord.status,
          submittedAt: storedRecord.submittedAt,
          delivery,
          issuePreview,
        },
        201,
        corsHeaders,
      );
    }

    if (url.pathname === "/api/suggestions") {
      const methodHeaders = new Headers(corsHeaders);
      methodHeaders.set("Allow", "POST, OPTIONS");

      return jsonResponse(
        {
          error: "method_not_allowed",
          message: "This endpoint only accepts POST requests.",
        },
        405,
        methodHeaders,
      );
    }

    return jsonResponse(
      {
        error: "not_found",
        message: "The requested endpoint does not exist.",
      },
      404,
      corsHeaders,
    );
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(handleScheduledRecovery(controller, env));
  },
};
