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
function readPasted(rl) {
  return new Promise((resolve) => {
    const lines = [];
    console.log('\nPaste the service account JSON now (auto-detected when complete):\n');
    const cleanup = () => rl.removeListener('line', onLine);
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

async function doSend(rl, source) {
  const deviceToken = (await ask(rl, 'Device (registration) token: ', 'paste the device token')).trim();
  if (!deviceToken) throw new Error('Device token is required.');
  const title = (await ask(rl, 'Title: ', 'e.g. Hello')).trim();
  const body = (await ask(rl, 'Body : ', 'e.g. World')).trim();

  const res = await sendPush(source, {
    token: deviceToken,
    notification: { title, body },
  });
  console.log(c.bgreen('\n✓ Push sent.') + c.dim(' FCM response:'));
  console.log('  ' + c.cyan(JSON.stringify(res)) + '\n');
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
      console.log(`  ${c.green('[2]')} Send a test push`);
      console.log(`  ${c.green('[3]')} Change service account`);
      console.log(`  ${c.green('[4]')} Forget saved service account`);
      console.log(`  ${c.green('[5]')} Exit\n`);

      const choice = (await ask(rl, c.bcyan('Choose: '), 'enter 1-5 and press Enter')).trim();

      try {
        if (choice === '1') {
          await doToken(savedSource(saved));
        } else if (choice === '2') {
          await doSend(rl, savedSource(saved));
        } else if (choice === '3') {
          await setupServiceAccount(rl);
        } else if (choice === '4') {
          forgetLastAccount();
          console.log(c.yellow('\nForgotten. Setting up a new one.'));
          await setupServiceAccount(rl);
        } else if (choice === '5' || choice.toLowerCase() === 'exit' || choice === '') {
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
  console.log('  ' + c.dim('send push notifications. Remembers your account.'));
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
  fcm-token send  [source]      Send a test push (interactive prompts)
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

Examples:
  npx fcm-v1-token                       # menu, remembers your file
  fcm-token use ./service-account.json   # remember this file
  fcm-token token --raw                  # print token using saved account
  TOKEN=$(fcm-token token --raw)
  fcm-token send                         # push using saved account
`);
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return;
  }

  const opts = {
    json: argv.includes('--json'),
    raw: argv.includes('--raw'),
    copy: !argv.includes('--no-copy'),
  };
  const positional = argv.filter((a) => !a.startsWith('--'));

  const COMMANDS = new Set(['token', 'send', 'use', 'whoami', 'forget']);
  let command;
  let sourceArg;
  if (positional.length && COMMANDS.has(positional[0])) {
    command = positional[0];
    sourceArg = positional[1];
  } else if (positional.length) {
    // First positional is a source -> default to token.
    command = 'token';
    sourceArg = positional[0];
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

  if (command === 'send') {
    await withRL(async (rl) => {
      const source = await resolveSource(rl, sourceArg);
      await doSend(rl, source);
    });
    return;
  }
}

main().catch((err) => {
  console.error(c.red(`\nError: ${err.message}\n`));
  process.exit(1);
});
