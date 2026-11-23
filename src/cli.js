#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');
const { version: VERSION } = require('../package.json');
const {
  getAccessToken,
  sendPush,
  buildMessage,
  normalizeTopic,
  normalizeData,
  loadServiceAccount,
  saveLastAccount,
  loadLastAccount,
  savedSource,
  forgetLastAccount,
  configFile,
} = require('./index');

// ---------------------------------------------------------------------------
// Colors (auto-disabled when not a TTY or when NO_COLOR is set)
// ---------------------------------------------------------------------------

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = {
  green: paint('32'),
  cyan: paint('36'),
  yellow: paint('33'),
  red: paint('31'),
  gray: paint('90'),
  dim: paint('2'),
  bold: paint('1'),
  bgreen: paint('1;32'),
  bcyan: paint('1;36'),
};

// ---------------------------------------------------------------------------
// Clipboard (best effort, per platform)
// ---------------------------------------------------------------------------

function copyToClipboard(text) {
  let cmd;
  let args = [];
  if (process.platform === 'darwin') {
    cmd = 'pbcopy';
  } else if (process.platform === 'win32') {
    cmd = 'clip';
  } else {
    cmd = 'xclip';
    args = ['-selection', 'clipboard'];
  }
  try {
    const res = spawnSync(cmd, args, { input: text });
    return res.status === 0;
  } catch (_e) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Small prompt helpers
// ---------------------------------------------------------------------------

function withRL(fn) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return Promise.resolve(fn(rl)).finally(() => rl.close());
}

// Ask a question. If `placeholder` is given and we are on a color TTY, show a
// dim ghost hint after the cursor that disappears as soon as the user types.
function ask(rl, q, placeholder) {
  return new Promise((resolve) => {
    if (!placeholder || !useColor || !process.stdin.isTTY) {
      rl.question(q, (a) => resolve(a));
      return;
    }
    const onKey = () => {
      // First keypress: wipe the ghost text to the right of the cursor.
      process.stdout.write('\x1b[0K');
      process.stdin.removeListener('keypress', onKey);
    };
    rl.question(q, (a) => {
      process.stdin.removeListener('keypress', onKey);
      resolve(a);
    });
    // Draw ghost hint, then move the cursor back over it so typing overwrites it.
    process.stdout.write(c.dim(placeholder) + `\x1b[${placeholder.length}D`);
    process.stdin.on('keypress', onKey);
  });
}

// Read pasted multi-line JSON. Auto-detects completion once the accumulated
// text parses as JSON, so the user does not have to type anything after the
// paste. Typing END on its own line is a manual fallback.
function readPasted(rl, what = 'the service account JSON') {
  return new Promise((resolve) => {
    const lines = [];
    console.log(`\nPaste ${what} now (auto-detected when complete):\n`);
    const cleanup = () => {
      rl.removeListener('line', onLine);
      rl.removeListener('close', onClose);
    };
    const onClose = () => {
      cleanup();
      resolve(lines.join('\n'));
    };
    const onLine = (line) => {
      if (line.trim() === 'END') {
        cleanup();
        resolve(lines.join('\n'));
        return;
      }
      lines.push(line);
      const joined = lines.join('\n').trim();
      if (joined.startsWith('{')) {
        try {
          JSON.parse(joined);
          cleanup();
          resolve(joined); // complete JSON object received
        } catch (_e) {
          /* not complete yet — keep reading */
        }
      }
    };
    rl.on('line', onLine);
    rl.on('close', onClose);
  });
}

// Read custom data: one key=value per line until an empty line, or a pasted
// JSON object. Bad lines are rejected on the spot so nothing typed is lost.
function readData(rl) {
  return new Promise((resolve) => {
    const data = {};
    let jsonLines = null;
    console.log(c.dim('  One key=value per line, empty line to finish — or paste a JSON object.'));
    const prompt = () => {
      rl.setPrompt(c.gray('  › '));
      rl.prompt();
    };
    const finish = (result) => {
      rl.removeListener('line', onLine);
      rl.removeListener('close', onClose);
      resolve(result);
    };
    const onClose = () => finish(data);
    const tryAdd = (obj) => {
      try {
        normalizeData(obj); // reserved keys etc. -> throws
        Object.assign(data, obj);
        return true;
      } catch (err) {
        console.log(c.yellow(`    ${err.message}`));
        return false;
      }
    };
    const onLine = (line) => {
      const t = line.trim();
      if (jsonLines) {
        jsonLines.push(line);
        try {
          const obj = JSON.parse(jsonLines.join('\n')); // starts with "{" -> an object
          jsonLines = null;
          if (tryAdd(obj)) {
            finish(data);
            return;
          }
          prompt();
        } catch (_e) {
          /* JSON not complete yet */
        }
        return;
      }
      if (t === '') {
        finish(data);
        return;
      }
      if (t.startsWith('{')) {
        jsonLines = [];
        onLine(line);
        return;
      }
      const eq = t.indexOf('=');
      if (eq <= 0) {
        console.log(c.yellow('    Use key=value (or an empty line to finish).'));
      } else {
        tryAdd({ [t.slice(0, eq).trim()]: t.slice(eq + 1).trim() });
      }
      prompt();
    };
    rl.on('line', onLine);
    rl.on('close', onClose);
    prompt();
  });
}

// ---------------------------------------------------------------------------
// Service account discovery (for auto-detect)
// ---------------------------------------------------------------------------

function looksLikeServiceAccount(file) {
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Boolean(json.client_email && json.private_key);
  } catch (_e) {
    return false;
  }
}

function findCandidates(dir, depth = 2) {
  const results = [];
  const IGNORE = new Set(['node_modules', '.git', '.next', 'dist', 'build']);
  function walk(d, level) {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch (_e) {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || IGNORE.has(e.name)) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (level > 0) walk(full, level - 1);
      } else if (e.isFile() && e.name.endsWith('.json') && looksLikeServiceAccount(full)) {
        results.push(full);
      }
    }
  }
  walk(dir, depth);
  return results;
}

// ---------------------------------------------------------------------------
// Obtain (and remember) a service account interactively
// ---------------------------------------------------------------------------

// Returns { source, saved } where source is a path string or credentials object.
async function setupServiceAccount(rl) {
  console.log('\nHow do you want to provide the service account?\n');
  console.log('  [1] File path');
  console.log('  [2] Paste JSON content');
  console.log('  [3] Auto-detect from current folder\n');
  const choice = (await ask(rl, c.bcyan('Choose: '), 'enter 1, 2 or 3 and press Enter')).trim();

  if (choice === '2') {
    const content = await readPasted(rl);
    const sa = loadServiceAccount(content); // validates
    saveLastAccount(sa, { type: 'pasted' });
    console.log(c.green(`\n✓ Saved (${sa.client_email}). It will be remembered next time.`));
    return sa;
  }

  if (choice === '3') {
    const candidates = findCandidates(process.cwd());
    if (candidates.length === 0) {
      console.log('\nNo service account JSON found in this folder.');
      return setupFromPath(rl);
    }
    console.log('\nService account files found:\n');
    candidates.forEach((f, i) => {
      console.log(`  [${i + 1}] ${path.relative(process.cwd(), f)}`);
    });
    const ans = (await ask(rl, c.bcyan('\nChoose a number: '), 'enter a number and press Enter')).trim();
    const idx = parseInt(ans, 10);
    if (!Number.isInteger(idx) || idx < 1 || idx > candidates.length) {
      throw new Error('Invalid choice.');
    }
    return rememberPath(candidates[idx - 1]);
  }

  // default: file path
  return setupFromPath(rl);
}

async function setupFromPath(rl) {
  const p = (await ask(rl, 'Enter the service account file path: ', 'e.g. ./service-account.json')).trim();
  return rememberPath(p);
}

function rememberPath(p) {
  const abs = path.resolve(p);
  const sa = loadServiceAccount(abs); // validates + throws if bad
  saveLastAccount(sa, { type: 'path', path: abs });
  console.log(`\nSaved (${sa.client_email}). It will be remembered next time.`);
  return abs;
}

// Resolve a usable source: explicit arg > saved config > interactive setup.
async function resolveSource(rl, pathArg) {
  if (pathArg) {
    // Treat "-" as: read pasted content from stdin is not interactive here,
    // so just handle a normal path/JSON string.
    return rememberFromArg(pathArg);
  }
  const saved = loadLastAccount();
  if (saved) return savedSource(saved);
  return setupServiceAccount(rl);
}

function rememberFromArg(arg) {
  const trimmed = String(arg).trim();
  if (trimmed.startsWith('{')) {
    const sa = loadServiceAccount(trimmed);
    saveLastAccount(sa, { type: 'pasted' });
    return sa;
  }
  return rememberPath(trimmed);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function fmtExpiry(expiresAt) {
  if (!expiresAt) return 'unknown';
  const mins = Math.round((expiresAt - Date.now()) / 60000);
  return `${new Date(expiresAt).toLocaleString()} (~${mins} min left)`;
}

async function doToken(source, opts = {}) {
  const info = await getAccessToken(source);
  if (opts.json) {
    console.log(JSON.stringify(info, null, 2));
    return;
  }
  if (opts.raw) {
    // Plain, single line — perfect for scripting / piping.
    process.stdout.write(info.token + '\n');
    return;
  }

  const copied = opts.copy === false ? false : copyToClipboard(info.token);

  console.log(
    '\n' + c.bgreen('✓ Access token generated') +
    (copied ? c.green('  ✓ copied to clipboard') : '')
  );
  console.log(`  ${c.dim('Project')} : ${c.cyan(info.projectId || '(none)')}`);
  console.log(`  ${c.dim('Client ')} : ${c.cyan(info.clientEmail)}`);
  console.log(`  ${c.dim('Expires')} : ${c.yellow(fmtExpiry(info.expiresAt))}`);
  console.log(c.dim('\n  Token (triple-click the line below to select):\n'));
  // Flush-left, on its own line, no wrapping decoration -> easy to copy.
  console.log(c.green(info.token));
  console.log('');
}

// ---------------------------------------------------------------------------
// Sending: to a device token or a topic. The message is either composed
// interactively (with a preview + confirmation) or built straight from flags.
// ---------------------------------------------------------------------------

const IMAGE_RE = /^https?:\/\/\S+$/i;
const TARGET_KEYS = ['token', 'topic', 'condition'];

function targetFromFlags(flags) {
  if (flags.topic && flags.device) throw new Error('Use either --topic or --device, not both.');
  if (flags.topic) return { topic: normalizeTopic(flags.topic) };
  if (flags.device) return { token: String(flags.device).trim() };
  return null;
}

function hasContentFlags(flags) {
  return flags.title !== undefined || flags.body !== undefined || flags.image !== undefined ||
    flags.data.length > 0 || Boolean(flags.dataOnly);
}

// --data can be repeated; each value is key=value or a JSON object.
function parseDataFlags(values) {
  const data = {};
  for (const v of values) {
    const t = String(v).trim();
    if (t.startsWith('{')) {
      let obj;
      try {
        obj = JSON.parse(t);
      } catch (_e) {
        throw new Error(`--data is not valid JSON: ${t}`);
      }
      Object.assign(data, obj);
    } else {
      const eq = t.indexOf('=');
      if (eq <= 0) throw new Error(`--data expects key=value, got: ${t}`);
      data[t.slice(0, eq).trim()] = t.slice(eq + 1);
    }
  }
  return data;
}

// Options that apply to both the flag mode and the interactive composer.
function extrasFromFlags(flags) {
  const o = {};
  if (flags.sound !== undefined) o.sound = flags.sound;
  if (flags.channel) o.channelId = flags.channel;
  if (flags.clickAction) o.clickAction = flags.clickAction;
  if (flags.priority) o.priority = String(flags.priority).toLowerCase();
  return o;
}

function contentFromFlags(flags) {
  const o = extrasFromFlags(flags);
  if (flags.title !== undefined) o.title = flags.title;
  if (flags.body !== undefined) o.body = flags.body;
  if (flags.image !== undefined) o.image = flags.image;
  if (flags.data.length) o.data = parseDataFlags(flags.data);
  if (flags.dataOnly) o.dataOnly = true;
  return o;
}

// --message: JSON content or a path to a .json file.
function readMessageArg(arg) {
  const t = String(arg).trim();
  if (t.startsWith('{')) return t;
  try {
    return fs.readFileSync(path.resolve(t), 'utf8');
  } catch (_e) {
    throw new Error(`--message is neither JSON nor a readable file: ${t}`);
  }
}

// A full FCM v1 message pasted/passed by the user. Accepts { message: {...} }
// too. A given target replaces whatever target the JSON had.
function customMessage(raw, target) {
  let obj;
  try {
    obj = JSON.parse(String(raw).trim());
  } catch (_e) {
    throw new Error('The custom message is not valid JSON.');
  }
  if (obj && obj.message && typeof obj.message === 'object') obj = obj.message;
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('The custom message must be a JSON object.');
  }
  const message = { ...obj };
  if (target) {
    TARGET_KEYS.forEach((k) => delete message[k]);
    Object.assign(message, target);
  }
  if (message.topic) message.topic = normalizeTopic(message.topic);
  if (TARGET_KEYS.filter((k) => message[k]).length > 1) {
    throw new Error('The custom message has more than one target (token/topic/condition).');
  }
  if (message.data !== undefined) message.data = normalizeData(message.data);
  return message;
}

async function askTarget(rl, kind) {
  if (kind === 'topic') {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const t = (await ask(rl, 'Topic : ', 'e.g. news')).trim();
      try {
        return { topic: normalizeTopic(t) };
      } catch (err) {
        console.log(c.yellow(`  ${err.message}`));
      }
    }
  }
  const t = (await ask(rl, 'Device (registration) token: ', 'paste the device token')).trim();
  if (!t) throw new Error('Device token is required.');
  return { token: t };
}

async function askMoreOptions(rl) {
  const o = {};
  const sound = (await ask(rl, 'Sound           : ', 'Enter = default, a sound name, or none')).trim();
  if (sound) o.sound = sound;
  const channel = (await ask(rl, 'Android channel : ', 'optional channel id')).trim();
  if (channel) o.channelId = channel;
  const click = (await ask(rl, 'Click action    : ', 'optional, e.g. FLUTTER_NOTIFICATION_CLICK')).trim();
  if (click) o.clickAction = click;
  const prio = (await ask(rl, 'Priority        : ', 'high (Enter) or normal')).trim().toLowerCase();
  if (prio === 'normal') o.priority = 'normal';
  else if (prio && prio !== 'high') console.log(c.yellow('  Unknown priority — using high.'));
  return o;
}

// Interactive composer: notification / notification + data / data only / custom JSON.
async function composeMessage(rl, target, extras = {}) {
  console.log('\n' + c.bold('What do you want to send?') + '\n');
  console.log(`  ${c.green('[1]')} Notification         ${c.dim('title, body, image — shows in the tray')}`);
  console.log(`  ${c.green('[2]')} Notification + data  ${c.dim('the same, plus your own key/value data')}`);
  console.log(`  ${c.green('[3]')} Data only            ${c.dim('silent — your app code handles it')}`);
  console.log(`  ${c.green('[4]')} Custom JSON          ${c.dim('paste a full FCM v1 message')}\n`);
  const type = (await ask(rl, c.bcyan('Choose: '), 'enter 1-4 (Enter = 1)')).trim() || '1';
  if (!['1', '2', '3', '4'].includes(type)) throw new Error('Invalid choice.');

  if (type === '4') {
    const raw = await readPasted(rl, 'the FCM message JSON ({"notification": {...}, "data": {...}, ...})');
    return customMessage(raw, target);
  }

  const opts = { ...target, ...extras };
  if (type === '3') {
    opts.dataOnly = true;
  } else {
    while (!opts.title && !opts.body) {
      opts.title = (await ask(rl, 'Title : ', 'e.g. Hello')).trim();
      opts.body = (await ask(rl, 'Body  : ', 'e.g. World')).trim();
      if (!opts.title && !opts.body) console.log(c.yellow('  Enter a title or a body.'));
    }
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const img = (await ask(rl, 'Image : ', 'optional https:// URL — Enter to skip')).trim();
      if (!img || IMAGE_RE.test(img)) {
        if (img) opts.image = img;
        break;
      }
      console.log(c.yellow('  The image must be an http(s) URL.'));
    }
  }

  if (type === '2' || type === '3') {
    console.log('\n' + c.bold('Data') + (type === '2' ? c.dim(' (optional)') : ''));
    // eslint-disable-next-line no-constant-condition
    while (true) {
      opts.data = await readData(rl);
      if (type === '2' || Object.keys(opts.data).length) break;
      console.log(c.yellow('  A data-only message needs at least one key=value.'));
    }
  }

  if (type !== '3' && Object.keys(extras).length === 0) {
    const more = (await ask(rl, 'More options (sound, channel, click action, priority)? ', 'y/N')).trim().toLowerCase();
    if (more === 'y' || more === 'yes') Object.assign(opts, await askMoreOptions(rl));
  }
  return buildMessage(opts);
}

function describeTarget(message) {
  if (message.topic) return `topic "${message.topic}"`;
  if (message.condition) return `condition ${message.condition}`;
  return 'the device';
}

function printSendResult(message, res, dryRun, json) {
  if (json) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  const where = describeTarget(message);
  if (dryRun) {
    console.log(c.bgreen('\n✓ Valid.') + ` FCM accepted the message for ${where} ` +
      c.dim('(dry run — nothing was delivered).'));
  } else {
    console.log(c.bgreen(`\n✓ Sent to ${where}.`));
  }
  if (res && res.name) console.log(`  ${c.dim('Message ID')} : ${c.cyan(res.name)}`);
  if (message.topic && !dryRun) {
    console.log(c.dim('  Every device subscribed to this topic receives it. FCM does not report how many that is.'));
  }
  console.log('');
}

async function doSend(rl, source, kind, flags) {
  const target = targetFromFlags(flags);
  const fromFlags = Boolean(flags.message) || hasContentFlags(flags);
  let message;

  if (flags.message) {
    message = customMessage(readMessageArg(flags.message), target);
    if (!TARGET_KEYS.some((k) => message[k])) Object.assign(message, await askTarget(rl, kind));
  } else {
    const to = target || (await askTarget(rl, kind));
    message = fromFlags
      ? buildMessage({ ...to, ...contentFromFlags(flags) })
      : await composeMessage(rl, to, extrasFromFlags(flags));
  }

  let dryRun = Boolean(flags.dryRun);

  // Interactive: always show what will be sent and ask before sending.
  if (!fromFlags && !flags.yes) {
    console.log('\n' + c.bold('Message preview') + c.dim(' (FCM v1 JSON)'));
    console.log(JSON.stringify(message, null, 2).split('\n').map((l) => '  ' + c.cyan(l)).join('\n'));
    if (message.topic && !dryRun) {
      console.log(c.yellow(`\n  ⚠ This goes to EVERY device subscribed to topic "${message.topic}".`));
    }
    const answer = (await ask(
      rl,
      c.bcyan(dryRun ? '\nValidate it now (dry run)? ' : '\nSend now? '),
      dryRun ? 'Y/n' : 'Y = send · d = dry run (validate only) · n = cancel'
    )).trim().toLowerCase();
    if (answer === 'd' || answer === 'dry') {
      dryRun = true;
    } else if (!['', 'y', 'yes'].includes(answer)) {
      console.log(c.dim('\nCancelled — nothing was sent.\n'));
      return null;
    }
  }

  const res = await sendPush(source, message, { dryRun });
  printSendResult(message, res, dryRun, flags.json);
  return res;
}

function showSaved() {
  const saved = loadLastAccount();
  if (!saved) {
    console.log('\nNo service account saved yet.\n');
    return;
  }
  console.log('\nSaved service account:\n');
  console.log(`  Client   : ${saved.summary.clientEmail}`);
  console.log(`  Project  : ${saved.summary.projectId || '(none)'}`);
  console.log(`  Source   : ${saved.source.type}${saved.source.path ? ' — ' + saved.source.path : ''}`);
  console.log(`  Saved at : ${saved.savedAt}`);
  console.log(`  Config   : ${configFile()}\n`);
}

// ---------------------------------------------------------------------------
// Interactive main menu (default when no command is given)
// ---------------------------------------------------------------------------

async function interactive() {
  printBanner();
  await withRL(async (rl) => {
    let saved = loadLastAccount();

    if (!saved) {
      console.log(c.yellow('No service account is saved yet. Let’s set one up.'));
      await setupServiceAccount(rl);
      saved = loadLastAccount();
    }

    // Menu loop
    // eslint-disable-next-line no-constant-condition
    while (true) {
      saved = loadLastAccount();
      const line = c.gray('────────────────────────────────────────');
      console.log('\n' + line);
      console.log(
        c.dim('Using: ') + c.bcyan(saved.summary.clientEmail) +
        (saved.summary.projectId ? c.dim(`  (project: ${saved.summary.projectId})`) : '')
      );
      console.log(line);
      console.log(c.bold('What do you want to do?') + '\n');
      console.log(`  ${c.green('[1]')} Get access token`);
      console.log(`  ${c.green('[2]')} Send a test push to a device`);
      console.log(`  ${c.green('[3]')} Send a real notification to a topic`);
      console.log(`  ${c.green('[4]')} Change service account`);
      console.log(`  ${c.green('[5]')} Forget saved service account`);
      console.log(`  ${c.green('[6]')} Exit\n`);

      const choice = (await ask(rl, c.bcyan('Choose: '), 'enter 1-6 and press Enter')).trim();

      try {
        if (choice === '1') {
          await doToken(savedSource(saved));
        } else if (choice === '2') {
          await doSend(rl, savedSource(saved), 'device', EMPTY_FLAGS);
        } else if (choice === '3') {
          await doSend(rl, savedSource(saved), 'topic', EMPTY_FLAGS);
        } else if (choice === '4') {
          await setupServiceAccount(rl);
        } else if (choice === '5') {
          forgetLastAccount();
          console.log(c.yellow('\nForgotten. Setting up a new one.'));
          await setupServiceAccount(rl);
        } else if (choice === '6' || choice.toLowerCase() === 'exit' || choice === '') {
          console.log(c.dim('\nBye.\n'));
          return;
        } else {
          console.log(c.red('\nInvalid choice.'));
        }
      } catch (err) {
        // Keep the menu alive on a failed action (bad key, network, etc.).
        console.error(c.red(`\nError: ${err.message}`));
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Help + arg parsing
// ---------------------------------------------------------------------------

// A compact, colorful header shown at startup and in help.
function printBanner() {
  const rule = c.gray('──────────────────────────────────────────────────────');
  console.log('');
  console.log('  ' + c.bcyan('🔥 fcm-v1-token') + c.dim(`  v${VERSION}`));
  console.log('  ' + c.dim('Firebase service account ') + c.gray('→') +
    c.dim(' FCM v1 OAuth token & push'));
  console.log('  ' + rule);
  console.log('  ' + c.dim('Turns a service account key into a 1-hour access token'));
  console.log('  ' + c.dim('for the FCM v1 API — cached & auto-refreshed — and can'));
  console.log('  ' + c.dim('send push to a device or a topic. Remembers your account.'));
  console.log('');
}

function printHelp() {
  printBanner();
  console.log(`  Commands: fcm-v1-token | fcm-token | fcmt   (via npx: npx fcm-v1-token)

Run with no arguments for an interactive menu. Your service account
(path or pasted content) is remembered between runs.

Usage:
  fcm-token                     Interactive menu (remembers last account)
  fcm-token token [source]      Print an access token
  fcm-token send  [source]      Send a push to a device (interactive prompts)
  fcm-token topic [source]      Send a notification to a topic (interactive)
  fcm-token use   <source>      Set / replace the saved service account
  fcm-token whoami              Show the saved service account
  fcm-token forget              Remove the saved service account
  fcm-token --help              This help

[source] is optional. If omitted, the saved account is used. It can be:
  - a file path            e.g.  ./service-account.json
  - JSON content           e.g.  '{"type":"service_account",...}'

Options (for "token"):
  --json      Print full info (token, projectId, expiry) as JSON
  --raw       Print only the token (for scripting)
  --no-copy   Do not copy the token to the clipboard

Options (for "send" / "topic") — with any content option it sends right away,
without prompts; without them you get the interactive composer:
  --topic <name>          Send to every device subscribed to this topic
  --device <token>        Send to one device registration token
  --title <text>          Notification title
  --body <text>           Notification body
  --image <url>           Image URL (Android, iOS and web)
  --data <key=value>      Custom data; repeat it, or pass a JSON object
  --data-only             Silent data message (no title/body/image)
  --message <json|file>   A full custom FCM v1 message (JSON or .json file)
  --sound <name|none>     Notification sound (default: "default")
  --channel <id>          Android notification channel id
  --click-action <name>   Android click_action / iOS category
  --priority <high|normal>  Delivery priority (default: high)
  --dry-run               Validate with FCM only — nothing is delivered
  --yes, -y               Interactive mode: send without the confirm step
  --json                  Print the raw FCM response as JSON

Examples:
  npx fcm-v1-token                       # menu, remembers your file
  fcm-token use ./service-account.json   # remember this file
  fcm-token token --raw                  # print token using saved account
  TOKEN=$(fcm-token token --raw)
  fcm-token send                         # push to a device, using saved account
  fcm-token topic                        # notification to a topic (interactive)
  fcm-token send --topic news --title "Hi" --body "Hello" \\
      --image https://example.com/a.png --data screen=home --data id=42
  fcm-token send --topic news --data-only --data '{"type":"sync"}'
  fcm-token send --topic news --title "Test" --dry-run
`);
}

// Flags that take a value, and boolean switches. Names map to keys in `flags`.
const VALUE_FLAGS = {
  topic: 'topic',
  device: 'device',
  title: 'title',
  body: 'body',
  image: 'image',
  data: 'data',
  message: 'message',
  sound: 'sound',
  channel: 'channel',
  'click-action': 'clickAction',
  priority: 'priority',
};
const BOOL_FLAGS = {
  help: 'help',
  json: 'json',
  raw: 'raw',
  'no-copy': 'noCopy',
  'data-only': 'dataOnly',
  'dry-run': 'dryRun',
  yes: 'yes',
};
const SHORT_FLAGS = { h: 'help', y: 'yes' };
const EMPTY_FLAGS = Object.freeze({ data: [] });

// Supports "--flag value", "--flag=value", repeated --data and "--" to end flags.
function parseArgs(argv) {
  const flags = { data: [] };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (/^-[a-zA-Z]$/.test(a)) {
      const key = SHORT_FLAGS[a[1]];
      if (!key) throw new Error(`Unknown option ${a}. Run with --help.`);
      flags[key] = true;
      continue;
    }
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    let name = a.slice(2);
    let value;
    const eq = name.indexOf('=');
    if (eq !== -1) {
      value = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    if (BOOL_FLAGS[name]) {
      flags[BOOL_FLAGS[name]] = true;
      continue;
    }
    const key = VALUE_FLAGS[name];
    if (!key) throw new Error(`Unknown option --${name}. Run with --help.`);
    if (value === undefined) {
      if (i + 1 >= argv.length) throw new Error(`--${name} needs a value.`);
      value = argv[++i];
    }
    if (key === 'data') flags.data.push(value);
    else flags[key] = value;
  }
  return { flags, positional };
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));

  if (flags.help) {
    printHelp();
    return;
  }

  const opts = {
    json: Boolean(flags.json),
    raw: Boolean(flags.raw),
    copy: !flags.noCopy,
  };
  const wantsSend = Boolean(flags.topic || flags.device || flags.message) || hasContentFlags(flags);

  const COMMANDS = new Set(['token', 'send', 'topic', 'use', 'whoami', 'forget']);
  let command;
  let sourceArg;
  if (positional.length && COMMANDS.has(positional[0])) {
    command = positional[0];
    sourceArg = positional[1];
  } else if (positional.length) {
    // First positional is a source -> default to token (or send, if send flags were given).
    command = wantsSend ? 'send' : 'token';
    sourceArg = positional[0];
  } else if (wantsSend) {
    command = 'send';
  }

  // No command at all -> interactive menu.
  if (!command) {
    await interactive();
    return;
  }

  if (command === 'whoami') {
    showSaved();
    return;
  }

  if (command === 'forget') {
    const ok = forgetLastAccount();
    console.log(ok ? '\nSaved service account removed.\n' : '\nNothing was saved.\n');
    return;
  }

  if (command === 'use') {
    if (!sourceArg) {
      // Interactive setup if no source given.
      await withRL((rl) => setupServiceAccount(rl));
    } else {
      rememberFromArg(sourceArg);
      const saved = loadLastAccount();
      console.log(`\nSaved (${saved.summary.clientEmail}).\n`);
    }
    return;
  }

  if (command === 'token') {
    const source = await withRL((rl) => resolveSource(rl, sourceArg));
    await doToken(source, opts);
    return;
  }

  if (command === 'send' || command === 'topic') {
    await withRL(async (rl) => {
      const source = await resolveSource(rl, sourceArg);
      await doSend(rl, source, command === 'topic' ? 'topic' : 'device', flags);
    });
    return;
  }
}

main().catch((err) => {
  console.error(c.red(`\nError: ${err.message}\n`));
  process.exit(1);
});
