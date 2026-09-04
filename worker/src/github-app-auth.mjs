const GITHUB_API_BASE_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";

let cachedInstallationToken = null;

function requireText(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`The ${name} configuration is missing.`);
  }

  return value.trim();
}

function requirePositiveInteger(value, name) {
  const normalizedValue = Number(value);

  if (!Number.isSafeInteger(normalizedValue) || normalizedValue < 1) {
    throw new Error(`The ${name} configuration must be a positive integer.`);
  }

  return normalizedValue;
}

function bytesToBase64Url(bytes) {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function textToBase64Url(value) {
  return bytesToBase64Url(new TextEncoder().encode(value));
}

function decodeBase64(value) {
  let binary;

  try {
    binary = atob(value);
  } catch {
    throw new Error("The GitHub App private key secret is not valid Base64.");
  }

  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodePkcs8Secret(secret) {
  const outerBytes = decodeBase64(
    requireText(secret, "GITHUB_APP_PRIVATE_KEY_BASE64"),
  );
  const pem = new TextDecoder().decode(outerBytes).trim();

  const match = pem.match(
    /^-----BEGIN PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]+)\s+-----END PRIVATE KEY-----$/u,
  );

  if (!match) {
    throw new Error(
      "The GitHub App private key must be a Base64-encoded PKCS#8 PEM file.",
    );
  }

  return decodeBase64(match[1].replace(/\s+/gu, "")).buffer;
}

async function createGitHubAppJwt(env, now, cryptoImplementation) {
  const appId = requirePositiveInteger(env.GITHUB_APP_ID, "GITHUB_APP_ID");
  const privateKeyData = decodePkcs8Secret(
    env.GITHUB_APP_PRIVATE_KEY_BASE64,
  );
  const nowSeconds = Math.floor(now.getTime() / 1000);

  const header = {
    alg: "RS256",
    typ: "JWT",
  };

  const payload = {
    iat: nowSeconds - 60,
    exp: nowSeconds + 9 * 60,
    iss: appId,
  };

  const encodedHeader = textToBase64Url(JSON.stringify(header));
  const encodedPayload = textToBase64Url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const privateKey = await cryptoImplementation.subtle.importKey(
    "pkcs8",
    privateKeyData,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["sign"],
  );

  const signature = await cryptoImplementation.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(signingInput),
  );

  return `${signingInput}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

function tokenCanBeReused(cacheKey, now) {
  if (!cachedInstallationToken || cachedInstallationToken.cacheKey !== cacheKey) {
    return false;
  }

  return cachedInstallationToken.expiresAt.getTime() - now.getTime() > 5 * 60 * 1000;
}

async function readGitHubError(response) {
  try {
    const body = await response.json();
    return body?.message || `GitHub returned HTTP ${response.status}.`;
  } catch {
    return `GitHub returned HTTP ${response.status}.`;
  }
}

export async function getGitHubInstallationAccessToken(
  env,
  {
    fetchImplementation = fetch,
    cryptoImplementation = crypto,
    now = new Date(),
  } = {},
) {
  const installationId = requirePositiveInteger(
    env.GITHUB_APP_INSTALLATION_ID,
    "GITHUB_APP_INSTALLATION_ID",
  );
  const owner = requireText(env.GITHUB_REPOSITORY_OWNER, "GITHUB_REPOSITORY_OWNER");
  const repository = requireText(
    env.GITHUB_REPOSITORY_NAME,
    "GITHUB_REPOSITORY_NAME",
  );
  const appId = requirePositiveInteger(env.GITHUB_APP_ID, "GITHUB_APP_ID");
  const cacheKey = `${appId}:${installationId}:${owner}/${repository}`;

  if (tokenCanBeReused(cacheKey, now)) {
    return cachedInstallationToken.token;
  }

  const jwt = await createGitHubAppJwt(env, now, cryptoImplementation);
  const response = await fetchImplementation(
    `${GITHUB_API_BASE_URL}/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
        "User-Agent": "architectural-geometry-suggestions-worker",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
      body: JSON.stringify({
        repositories: [repository],
        permissions: {
          issues: "write",
        },
      }),
    },
  );

  if (!response.ok) {
    throw new Error(
      `Unable to obtain a GitHub App installation token: ${await readGitHubError(response)}`,
    );
  }

  const body = await response.json();
  const token = requireText(body?.token, "GitHub installation token");
  const expiresAt = new Date(body?.expires_at);

  if (Number.isNaN(expiresAt.getTime()) || expiresAt <= now) {
    throw new Error("GitHub returned an invalid installation-token expiry date.");
  }

  cachedInstallationToken = {
    cacheKey,
    token,
    expiresAt,
  };

  return token;
}

export function clearGitHubInstallationTokenCache() {
  cachedInstallationToken = null;
}
