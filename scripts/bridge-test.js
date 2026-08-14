/**
 * Bridge server tests — auth, validation, deduplication, token rotation.
 *
 *   npm run test:bridge
 *
 * Runs against a throwaway data directory; your real watchlist is untouched.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const PROJECT = path.join(__dirname, '..');
const DATA_DIR = path.join(os.tmpdir(), 'chorus-bridge-test');
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

const electronPath = require.resolve('electron', { paths: [PROJECT] });
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: { getPath: () => DATA_DIR },
    safeStorage: { isEncryptionAvailable: () => false }
  }
};

const bridge = require('../src/main/bridge');
const db = require('../src/main/db');

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, pass: Boolean(condition), detail });
  console.log(`${condition ? '[32mPASS[0m' : '[31mFAIL[0m'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function req(port, path, { token, method = 'GET', body } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

(async () => {
  let updates = 0;
  const { port, token } = await bridge.startBridge(() => {
    updates += 1;
  });
  console.log(`bridge listening on 127.0.0.1:${port}\n`);

  const ping = await req(port, '/ping');
  check('/ping works without a token', ping.status === 200 && ping.json.app === 'chorus');

  const noAuth = await req(port, '/verify');
  check('/verify rejects a missing token', noAuth.status === 401);

  const wrongAuth = await req(port, '/verify', { token: 'x'.repeat(32) });
  check('/verify rejects a wrong token', wrongAuth.status === 401);

  const good = await req(port, '/verify', { token });
  check('/verify accepts the real token', good.status === 200 && good.json.paired === true);

  const add = await req(port, '/candidate', {
    token,
    method: 'POST',
    body: { login: 'sindresorhus', url: 'https://github.com/sindresorhus/got', context: 'repo page' }
  });
  check('POST /candidate adds a person', add.status === 201 && add.json.added === true);
  check('bridge notified the app of the change', updates === 1, `updates=${updates}`);

  const dupe = await req(port, '/candidate', {
    token,
    method: 'POST',
    body: { login: 'sindresorhus', url: 'https://github.com/sindresorhus/got' }
  });
  check('duplicate is detected, not re-added', dupe.status === 200 && dupe.json.duplicate === true);

  const badLogin = await req(port, '/candidate', {
    token,
    method: 'POST',
    body: { login: 'not a valid login!!', url: 'https://github.com/x' }
  });
  check('invalid login is rejected', badLogin.status === 400, badLogin.json.error);

  const badUrl = await req(port, '/candidate', {
    token,
    method: 'POST',
    body: { login: 'octocat', url: 'https://evil.example.com/steal' }
  });
  check('non-github source URL is rejected', badUrl.status === 400, badUrl.json.error);

  const list = await req(port, '/watchlist', { token });
  check('/watchlist returns the queued person', list.json.items?.length === 1 && list.json.items[0].login === 'sindresorhus');

  check('db persisted the watchlist', db.watchlist().length === 1);

  const rotated = bridge.rotateToken();
  const afterRotate = await req(port, '/verify', { token });
  check('old token stops working after rotation', afterRotate.status === 401 && rotated !== token);

  bridge.stopBridge();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  // Set the code and let the loop drain — calling process.exit() here races the
  // server socket still closing and makes libuv assert on Windows.
  process.exitCode = failed.length ? 1 : 0;
})().catch((error) => {
  console.error('\nERROR:', error);
  process.exitCode = 1;
});
