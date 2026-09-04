import assert from "node:assert/strict";

import {
  clearGitHubInstallationTokenCache,
  getGitHubInstallationAccessToken,
} from "../worker/src/github-app-auth.mjs";

import {
  createGitHubAppIssueDelivery,
} from "../worker/src/github-api-client.mjs";

const repository = "example-owner/architectural-geometry";
const suggestionId = "11111111-1111-4111-8111-111111111111";
const marker =
  `<!-- architectural-geometry-suggestion-id: ${suggestionId} -->`;

const tests = [];

function test(name, run) {
  tests.push({ name, run });
}

function bytesToBase64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

async function createTestPrivateKeySecret() {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const innerBase64 = bytesToBase64(new Uint8Array(pkcs8));
  const lines = innerBase64.match(/.{1,64}/gu) ?? [];
  const pem = [
    "-----BEGIN PRIVATE KEY-----",
    ...lines,
    "-----END PRIVATE KEY-----",
    "",
  ].join("\n");

  return bytesToBase64(Buffer.from(pem, "utf8"));
}

function createEnvironment(privateKeySecret = "unused-in-client-tests") {
  return {
    GITHUB_APP_ID: "123456",
    GITHUB_APP_INSTALLATION_ID: "987654",
    GITHUB_APP_PRIVATE_KEY_BASE64: privateKeySecret,
    GITHUB_REPOSITORY_OWNER: "example-owner",
    GITHUB_REPOSITORY_NAME: "architectural-geometry",
  };
}

function createFormattedIssue() {
  return {
    title: "[Content suggestion] Test proposal",
    body: `## Test\n\n${marker}`,
    suggestionId,
    labels: ["content-suggestion", "operation:add", "status:open"],
  };
}

test("GitHub App JWT obtains a temporary installation token", async () => {
  clearGitHubInstallationTokenCache();
  const env = createEnvironment(await createTestPrivateKeySecret());
  const now = new Date("2026-09-01T12:00:00.000Z");
  let observedJwt;

  const token = await getGitHubInstallationAccessToken(env, {
    now,
    fetchImplementation: async (url, options) => {
      assert.equal(
        url,
        "https://api.github.com/app/installations/987654/access_tokens",
      );
      assert.equal(options.method, "POST");
      assert.match(options.headers.Authorization, /^Bearer [^.]+\.[^.]+\.[^.]+$/u);
      observedJwt = options.headers.Authorization.slice("Bearer ".length);

      const requestBody = JSON.parse(options.body);
      assert.deepEqual(requestBody.repositories, ["architectural-geometry"]);
      assert.deepEqual(requestBody.permissions, { issues: "write" });

      return new Response(
        JSON.stringify({
          token: "temporary-installation-token",
          expires_at: "2026-09-01T13:00:00.000Z",
        }),
        {
          status: 201,
          headers: { "Content-Type": "application/json" },
        },
      );
    },
  });

  assert.equal(token, "temporary-installation-token");

  const encodedPayload = observedJwt.split(".")[1]
    .replaceAll("-", "+")
    .replaceAll("_", "/");
  const payload = JSON.parse(
    Buffer.from(encodedPayload, "base64").toString("utf8"),
  );

  assert.equal(payload.iss, 123456);
  assert.equal(payload.iat, Math.floor(now.getTime() / 1000) - 60);
  assert.equal(payload.exp, Math.floor(now.getTime() / 1000) + 9 * 60);
});

test("Existing Issue is reused without creating another one", async () => {
  let postCount = 0;
  const deliverIssue = createGitHubAppIssueDelivery({
    env: createEnvironment(),
    tokenProvider: async () => "temporary-token",
    fetchImplementation: async (url, options) => {
      assert.equal(options.headers.Authorization, "Bearer temporary-token");

      if (options.method === "GET") {
        return Response.json([
          {
            number: 41,
            html_url: `https://github.com/${repository}/issues/41`,
            body: `Existing discussion.\n\n${marker}`,
          },
        ]);
      }

      postCount += 1;
      throw new Error(`Unexpected POST request to ${url}.`);
    },
  });

  const result = await deliverIssue(createFormattedIssue());

  assert.equal(result.issueNumber, 41);
  assert.equal(result.reused, true);
  assert.equal(postCount, 0);
});

test("A missing Issue is created on the staging fork", async () => {
  let createdBody;
  const deliverIssue = createGitHubAppIssueDelivery({
    env: createEnvironment(),
    tokenProvider: async () => "temporary-token",
    fetchImplementation: async (url, options) => {
      if (options.method === "GET") {
        return Response.json([]);
      }

      assert.equal(
        url,
        `https://api.github.com/repos/${repository}/issues`,
      );
      createdBody = JSON.parse(options.body);

      return Response.json(
        {
          number: 42,
          html_url: `https://github.com/${repository}/issues/42`,
        },
        { status: 201 },
      );
    },
  });

  const result = await deliverIssue(createFormattedIssue());

  assert.equal(result.issueNumber, 42);
  assert.equal(result.reused, false);
  assert.equal(createdBody.title, "[Content suggestion] Test proposal");
  assert.ok(createdBody.body.includes(marker));
});

test("Malformed repository configuration is rejected before GitHub is contacted", async () => {
  const env = {
    ...createEnvironment(),
    GITHUB_REPOSITORY_OWNER: "example-owner/invalid",
  };

  let requestCount = 0;

  const deliverIssue = createGitHubAppIssueDelivery({
    env,
    tokenProvider: async () => "temporary-token",
    fetchImplementation: async () => {
      requestCount += 1;
      throw new Error("The GitHub API must not be contacted.");
    },
  });

  await assert.rejects(
    deliverIssue(createFormattedIssue()),
    /invalid characters/u,
  );

  assert.equal(requestCount, 0);
});