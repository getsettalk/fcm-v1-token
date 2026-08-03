'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { JWT } = require('google-auth-library');

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

// Ek hi service account ke liye baar-baar naya JWT client mat banao.
// google-auth-library ka JWT client token ko internally cache karta hai
// (~1 hour) aur expire hone par khud refresh kar leta hai.
// Cache key = client_email.
const clientCache = new Map();

/**
 * Load + validate a service account from a file path, a pasted JSON string,
 * or a credentials object.
 * @param {string|object} source - file path, JSON content, or credentials object.
 * @returns {object} parsed service account
 */
function loadServiceAccount(source) {
  if (source && typeof source === 'object') {
    assertValid(source, '<object>');
    return source;
  }
  if (typeof source !== 'string' || source.trim() === '') {
    throw new Error('Provide a service account file path, JSON content, or object.');
  }

  const trimmed = source.trim();

  // Pasted JSON content (starts with "{") instead of a file path.
  if (trimmed.startsWith('{')) {
    let json;
    try {
      json = JSON.parse(trimmed);
    } catch (_e) {
      throw new Error('Invalid service account JSON content.');
    }
    assertValid(json, '<pasted content>');
    return json;
  }

  const abs = path.resolve(source);
  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (_e) {
    throw new Error(`Service account file not found: ${abs}`);
  }

  let json;
  try {
    json = JSON.parse(raw);
  } catch (_e) {
    throw new Error(`Service account file is not valid JSON: ${abs}`);
  }

  assertValid(json, abs);
  return json;
}

function assertValid(json, where) {
  if (!json.client_email || !json.private_key) {
    throw new Error(
      `Not a valid service account (missing client_email/private_key): ${where}`
    );
  }
}

function getClient(sa) {
  let client = clientCache.get(sa.client_email);
  if (!client) {
    client = new JWT({
      email: sa.client_email,
      key: sa.private_key,
      scopes: [FCM_SCOPE],
    });
    clientCache.set(sa.client_email, client);
  }
  return client;
}

/**
 * Get an OAuth2 access token from a service account.
 * The token is cached (~1 hour) and auto-refreshed before it expires,
 * so it is safe to call this repeatedly (e.g. before every push).
 *
 * @param {string|object} source - file path, JSON content, or credentials object
 * @returns {Promise<{token: string, projectId: string, clientEmail: string, expiresAt: number|null}>}
 */
async function getAccessToken(source) {
  const sa = loadServiceAccount(source);
  const client = getClient(sa);
  const { token } = await client.getAccessToken();
  if (!token) {
    throw new Error('Failed to obtain access token (Google returned an empty token).');
  }
  return {
    token,
    projectId: sa.project_id || null,
    clientEmail: sa.client_email,
    expiresAt: (client.credentials && client.credentials.expiry_date) || null,
  };
}

/**
 * FCM v1 API se ek message bhejo.
 *
 * @param {string|object} source - service account file path YA object
 * @param {object} message - FCM v1 "message" object, e.g.
 *   { token: '<device-token>', notification: { title, body }, data: {...} }
 * @param {object} [options]
 * @param {string} [options.projectId] - override; default service account ka project_id
 * @param {boolean} [options.dryRun] - true => validate_only (bhejta nahi, sirf check)
 * @returns {Promise<object>} FCM ka response
 */
async function sendPush(source, message, options = {}) {
  if (!message || typeof message !== 'object') {
    throw new Error('Provide an FCM "message" object (e.g. { token, notification }).');
  }

  const { token, projectId } = await getAccessToken(source);
  const project = options.projectId || projectId;
  if (!project) {
    throw new Error('No project_id found — pass options.projectId if it is not in the service account.');
  }

  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${project}/messages:send`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message, validate_only: !!options.dryRun }),
    }
  );

  let data = {};
  try {
    data = await res.json();
  } catch (_e) {
    /* empty body */
  }

  if (!res.ok) {
    const err = new Error(
      `FCM send failed (HTTP ${res.status}): ${JSON.stringify(data)}`
    );
    err.status = res.status;
    err.response = data;
    throw err;
  }
  return data;
}

/** Clear the in-memory token client cache (testing / key rotation). */
function clearCache() {
  clientCache.clear();
}

// ---------------------------------------------------------------------------
// Persistence: remember the last-used service account across CLI runs.
// Stored under ~/.fcm-v1-token/config.json with 0600 permissions.
// For a file path we store only the absolute path (key stays in the file).
// For pasted content we store the full JSON (there is no file to re-read).
// ---------------------------------------------------------------------------

function configDir() {
  return path.join(os.homedir(), '.fcm-v1-token');
}

function configFile() {
  return path.join(configDir(), 'config.json');
}

/**
 * Remember a service account for later runs.
 * @param {object} sa - validated service account object
 * @param {{type: 'path'|'pasted', path?: string}} source
 * @returns {string} config file path
 */
function saveLastAccount(sa, source) {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const payload = {
    savedAt: new Date().toISOString(),
    source: { type: source.type, path: source.path || null },
    summary: {
      clientEmail: sa.client_email,
      projectId: sa.project_id || null,
    },
  };
  // Only persist the key material when it was pasted (no file to fall back to).
  if (source.type === 'pasted') payload.serviceAccount = sa;

  const file = configFile();
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch (_e) {
    /* best effort */
  }
  return file;
}

/** Load the saved config, or null if none. */
function loadLastAccount() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  } catch (_e) {
    return null;
  }
  return parsed && parsed.source ? parsed : null;
}

/**
 * Turn a saved config into a `source` usable by getAccessToken/sendPush.
 * @returns {string|object} path string or credentials object
 */
function savedSource(saved) {
  if (saved.source.type === 'pasted') {
    if (!saved.serviceAccount) {
      throw new Error('Saved service account content is missing; set it again.');
    }
    return saved.serviceAccount;
  }
  if (!saved.source.path) {
    throw new Error('Saved service account path is missing; set it again.');
  }
  return saved.source.path;
}

/** Forget the saved service account. Returns true if something was removed. */
function forgetLastAccount() {
  try {
    fs.unlinkSync(configFile());
    return true;
  } catch (_e) {
    return false;
  }
}

module.exports = {
  getAccessToken,
  sendPush,
  loadServiceAccount,
  clearCache,
  // persistence
  saveLastAccount,
  loadLastAccount,
  savedSource,
  forgetLastAccount,
  configFile,
  FCM_SCOPE,
};
