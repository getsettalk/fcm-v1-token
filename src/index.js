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

// ---------------------------------------------------------------------------
// Message builder: simple options -> a cross-platform FCM v1 "message" object.
// ---------------------------------------------------------------------------

// FCM topic names: letters, numbers and - _ . ~ %  (the "/topics/" prefix is optional).
const TOPIC_RE = /^[a-zA-Z0-9\-_.~%]{1,900}$/;
// Keys FCM rejects inside "data".
const RESERVED_DATA_KEYS = new Set(['from', 'notification', 'message_type']);

/**
 * Validate a topic name and strip an optional "/topics/" prefix.
 * @param {string} topic
 * @returns {string} bare topic name, e.g. "news"
 */
function normalizeTopic(topic) {
  let t = String(topic == null ? '' : topic).trim();
  if (t.startsWith('/topics/')) t = t.slice('/topics/'.length);
  if (!t) throw new Error('Topic name is required.');
  if (!TOPIC_RE.test(t)) {
    throw new Error(`Invalid topic name "${t}". Use only letters, numbers and - _ . ~ %`);
  }
  return t;
}

/**
 * FCM "data" must be a flat map of string -> string. Non-string values are
 * JSON-encoded; reserved keys throw.
 * @param {object} data
 * @returns {Record<string,string>|undefined} undefined when empty
 */
function normalizeData(data) {
  if (data == null) return undefined;
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('data must be an object of key/value pairs.');
  }
  const out = {};
  for (const [rawKey, value] of Object.entries(data)) {
    const key = String(rawKey).trim();
    if (!key) throw new Error('Data keys cannot be empty.');
    if (RESERVED_DATA_KEYS.has(key) || key.startsWith('google.') || key.startsWith('gcm.')) {
      throw new Error(`"${key}" is a reserved FCM data key — use another name.`);
    }
    out[key] = value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Build an FCM v1 message that works on Android, iOS and web from simple options.
 *
 * - Notification: title/body (+ optional image) shown in the system tray.
 *   Images are set for Android/web (notification.image) and iOS
 *   (apns.fcm_options.image + mutable-content).
 * - Data only (`dataOnly: true`): no visible notification; delivered to your
 *   app's code. Sent high priority on Android and as a background push on iOS.
 *
 * @param {object} opts
 * @returns {object} FCM v1 "message" object, ready for sendPush()
 */
function buildMessage(opts = {}) {
  const {
    token, topic, condition,
    title, body, image, data, dataOnly,
    sound = 'default', channelId, clickAction, priority = 'high',
  } = opts;

  const targets = [token, topic, condition].filter((v) => v != null && String(v).trim() !== '');
  if (targets.length !== 1) {
    throw new Error('Set exactly one target: token, topic or condition.');
  }
  if (priority !== 'high' && priority !== 'normal') {
    throw new Error('priority must be "high" or "normal".');
  }

  const message = {};
  if (token) message.token = String(token).trim();
  if (topic) message.topic = normalizeTopic(topic);
  if (condition) message.condition = String(condition).trim();

  const payload = normalizeData(data);
  if (payload) message.data = payload;

  if (dataOnly) {
    if (!payload) throw new Error('A data-only message needs at least one data key/value.');
    if (title || body || image) {
      throw new Error('A data-only message cannot have a title, body or image.');
    }
    message.android = { priority };
    message.apns = {
      headers: { 'apns-push-type': 'background', 'apns-priority': '5' },
      payload: { aps: { 'content-available': 1 } },
    };
    return message;
  }

  if (!title && !body) {
    throw new Error('A notification needs a title or a body (or set dataOnly with data).');
  }
  if (image && !/^https?:\/\/\S+$/i.test(String(image))) {
    throw new Error('image must be an http(s) URL.');
  }

  message.notification = {};
  if (title) message.notification.title = String(title);
  if (body) message.notification.body = String(body);
  if (image) message.notification.image = String(image);

  const playSound = sound && sound !== 'none';

  const androidNote = {};
  if (playSound) androidNote.sound = sound;
  if (channelId) androidNote.channel_id = String(channelId);
  if (clickAction) androidNote.click_action = String(clickAction);
  const android = {};
  if (priority === 'normal') android.priority = 'normal'; // notifications default to high
  if (Object.keys(androidNote).length) android.notification = androidNote;
  if (Object.keys(android).length) message.android = android;

  const aps = {};
  if (playSound) aps.sound = sound;
  if (image) aps['mutable-content'] = 1; // lets the iOS service extension attach the image
  if (clickAction) aps.category = String(clickAction);
  const apns = {};
  if (priority === 'normal') apns.headers = { 'apns-priority': '5' };
  if (Object.keys(aps).length) apns.payload = { aps };
  if (image) apns.fcm_options = { image: String(image) };
  if (Object.keys(apns).length) message.apns = apns;

  return message;
}

/**
 * Send a notification (or data-only message) to every device subscribed to a topic.
 *
 * @param {string|object} source - service account file path, JSON content, or object
 * @param {string} topic - topic name, e.g. "news" (or "/topics/news")
 * @param {object} content - buildMessage() options without a target:
 *   { title, body, image, data, dataOnly, sound, channelId, clickAction, priority }
 * @param {object} [options] - { projectId?, dryRun? }
 * @returns {Promise<object>} FCM response, e.g. { name: 'projects/x/messages/123' }
 */
async function sendToTopic(source, topic, content = {}, options = {}) {
  const { token: _t, condition: _c, ...rest } = content || {};
  return sendPush(source, buildMessage({ ...rest, topic }), options);
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
  sendToTopic,
  buildMessage,
  normalizeTopic,
  normalizeData,
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
