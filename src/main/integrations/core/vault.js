// Encrypted-at-rest storage for OAuth tokens.
//
// Tokens live in their own file, encrypted with Electron's safeStorage, which on
// Windows binds the blob to the current OS user via DPAPI. Nothing else in the
// app reads this file: callers ask the vault for a token by account id and the
// value never travels further than the provider adapter that needs it.
//
// The renderer has no path to this module. Refresh tokens never leave here.

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

let cache = null;
let file = null;

function location() {
  if (!file) file = path.join(app.getPath('userData'), 'tokens.bin');
  return file;
}

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(location());
    const json = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(raw)
      : raw.toString('utf8');
    cache = JSON.parse(json);
  } catch {
    cache = {};
  }
  return cache;
}

function persist() {
  const json = JSON.stringify(cache || {});
  const blob = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(json)
    : Buffer.from(json, 'utf8');
  const target = location();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, blob, { mode: 0o600 });
  fs.renameSync(tmp, target);
}

/** True when the OS gave us real encryption rather than a plaintext fallback. */
function encryptionAvailable() {
  return safeStorage.isEncryptionAvailable();
}

/**
 * @param {string} accountId
 * @param {{accessToken:string, refreshToken?:string, expiresAt?:number|null, tokenType?:string}} tokens
 */
function put(accountId, tokens) {
  const store = load();
  store[accountId] = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken || '',
    expiresAt: tokens.expiresAt || null,
    tokenType: tokens.tokenType || 'Bearer',
    updatedAt: Date.now()
  };
  cache = store;
  persist();
}

function get(accountId) {
  return load()[accountId] || null;
}

function has(accountId) {
  return Boolean(load()[accountId]);
}

/** Update just the access token after a refresh, keeping the refresh token. */
function refreshed(accountId, { accessToken, expiresAt, refreshToken }) {
  const existing = get(accountId);
  if (!existing) return null;
  return put(accountId, {
    accessToken,
    // Providers that rotate refresh tokens send a new one; those that do not
    // expect us to keep using the original.
    refreshToken: refreshToken || existing.refreshToken,
    expiresAt: expiresAt ?? existing.expiresAt,
    tokenType: existing.tokenType
  });
}

/** Remove credentials entirely. Called on disconnect — nothing usable is left. */
function drop(accountId) {
  const store = load();
  if (!store[accountId]) return false;
  delete store[accountId];
  cache = store;
  persist();
  return true;
}

function dropAll() {
  cache = {};
  persist();
}

/** Diagnostics only — counts, never values. */
function stats() {
  const store = load();
  return {
    accounts: Object.keys(store).length,
    encrypted: encryptionAvailable()
  };
}

module.exports = { put, get, has, refreshed, drop, dropAll, stats, encryptionAvailable };
