// Connected account records.
//
// The record holds identity and status; the credentials live in the vault under
// the same id. Splitting them means anything that reads accounts — the IPC
// layer, the renderer, the AI action router — structurally cannot see a token.
//
// Every read that will lead to an action goes through `requireOwned`, which
// verifies the caller owns the record. The renderer sends ids, never trust.

const crypto = require('crypto');
const db = require('../../db');
const vault = require('./vault');
const audit = require('./audit');
const { IntegrationError, CODES } = require('./errors');

const STATUS = {
  CONNECTED: 'connected',
  EXPIRED: 'expired',
  REAUTH_REQUIRED: 'reauth-required',
  DISCONNECTED: 'disconnected',
  ERROR: 'error'
};

function all() {
  return db.collection('connectedAccounts');
}

/** Public shape — safe for IPC and the renderer. Never includes tokens. */
function toClient(account) {
  if (!account) return null;
  const tokens = vault.get(account.id);
  const expiresAt = tokens?.expiresAt || account.expiresAt || null;
  return {
    id: account.id,
    provider: account.provider,
    providerAccountId: account.providerAccountId,
    username: account.username,
    displayName: account.displayName,
    avatar: account.avatar || '',
    scopes: account.scopes || [],
    status: account.status,
    statusReason: account.statusReason || '',
    expiresAt,
    hasRefreshToken: Boolean(tokens?.refreshToken),
    metadata: account.metadata || {},
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    isMock: Boolean(account.isMock)
  };
}

function list() {
  return all().map(toClient);
}

function listRaw() {
  return all();
}

function find(id) {
  return all().find((account) => account.id === id) || null;
}

function findByProviderAccount(provider, providerAccountId) {
  return (
    all().find(
      (account) => account.provider === provider && account.providerAccountId === providerAccountId
    ) || null
  );
}

/**
 * The ownership gate. Anything that acts on an account must call this and use
 * the record it returns rather than one it looked up itself.
 */
function requireOwned(id, owner = db.ownerId()) {
  const account = find(id);
  if (!account) {
    throw new IntegrationError(CODES.NOT_CONNECTED, {
      message: 'That connected account no longer exists.'
    });
  }
  if (account.ownerId !== owner) {
    audit.record(audit.EVENTS.ACTION_DENIED, { accountId: id, reason: 'ownership' });
    throw new IntegrationError(CODES.OWNERSHIP);
  }
  return account;
}

/** Upsert on (provider, providerAccountId) so reconnecting keeps one record. */
function upsert({
  provider,
  providerAccountId,
  username,
  displayName,
  avatar,
  scopes,
  metadata,
  isMock
}, tokens) {
  const existing = findByProviderAccount(provider, providerAccountId);
  const now = new Date().toISOString();
  const reconnect = Boolean(existing);

  const account = existing || {
    id: crypto.randomUUID(),
    ownerId: db.ownerId(),
    provider,
    providerAccountId,
    createdAt: now,
    isMock: Boolean(isMock)
  };

  account.username = username || account.username || '';
  account.displayName = displayName || account.displayName || '';
  account.avatar = avatar || account.avatar || '';
  account.scopes = scopes || account.scopes || [];
  account.metadata = { ...(account.metadata || {}), ...(metadata || {}) };
  account.status = STATUS.CONNECTED;
  account.statusReason = '';
  account.expiresAt = tokens?.expiresAt || null;
  account.updatedAt = now;

  if (!existing) all().unshift(account);
  db.persist();

  if (tokens) vault.put(account.id, tokens);

  audit.record(reconnect ? audit.EVENTS.ACCOUNT_RECONNECTED : audit.EVENTS.ACCOUNT_CONNECTED, {
    accountId: account.id,
    provider,
    username: account.username,
    scopes: account.scopes
  });

  return account;
}

function setStatus(id, status, reason = '') {
  const account = find(id);
  if (!account) return null;
  account.status = status;
  account.statusReason = reason;
  account.updatedAt = new Date().toISOString();
  db.persist();
  return account;
}

/** Tokens for an owned account. Only provider adapters should call this. */
function credentials(id, owner) {
  const account = requireOwned(id, owner);
  const tokens = vault.get(id);
  if (!tokens) {
    setStatus(id, STATUS.REAUTH_REQUIRED, 'No stored credentials for this account.');
    throw new IntegrationError(CODES.AUTH_REQUIRED, { provider: account.provider });
  }
  return tokens;
}

/**
 * Remove an account. Credentials are dropped whether or not remote revocation
 * worked — a failed revoke must never leave a usable token behind.
 */
function remove(id, { revoked = false } = {}) {
  const account = find(id);
  if (!account) return false;

  vault.drop(id);

  const index = all().findIndex((entry) => entry.id === id);
  if (index !== -1) all().splice(index, 1);
  db.persist();

  audit.record(audit.EVENTS.ACCOUNT_DISCONNECTED, {
    accountId: id,
    provider: account.provider,
    username: account.username,
    revokedRemotely: revoked
  });

  return true;
}

/** Expiry check with a small skew so a token is refreshed just before it dies. */
function isExpired(account, skewMs = 60000) {
  const tokens = vault.get(account.id);
  const expiresAt = tokens?.expiresAt || account.expiresAt;
  if (!expiresAt) return false;
  return Date.now() + skewMs >= expiresAt;
}

module.exports = {
  STATUS,
  list,
  listRaw,
  find,
  findByProviderAccount,
  requireOwned,
  upsert,
  setStatus,
  credentials,
  remove,
  isExpired,
  toClient
};
