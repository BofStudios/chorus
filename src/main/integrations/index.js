// Public surface of the integration layer.
//
// Everything above this line — IPC, the renderer, the AI action router — talks
// to these functions and never to a provider adapter, an OAuth endpoint or the
// vault directly. That is what keeps credentials out of the model's reach and
// out of the renderer's process.

const registry = require('./core/registry');
const accounts = require('./core/accounts');
const oauth = require('./core/oauth');
const vault = require('./core/vault');
const audit = require('./core/audit');
const tools = require('./core/tools');
const router = require('./core/router');
const { IntegrationError, CODES } = require('./core/errors');
const { STATUS: CAP_STATUS } = require('./core/capabilities');

// Registered in the order they should appear in the UI.
require('./providers/composio');
require('./providers/x');
require('./providers/instagram');
require('./providers/reddit');
require('./providers/google');
require('./providers/linkedin');
require('./providers/mock');

// The loopback port the bridge server actually bound. Set by the bridge on
// start so redirect URIs always match the running instance.
let callbackPort = null;

function setCallbackPort(port) {
  callbackPort = port;
}

function requirePort() {
  if (!callbackPort) {
    throw new IntegrationError(CODES.PROVIDER_ERROR, {
      message: 'The local callback server is not running, so authorisation cannot complete. Restart Chorus.'
    });
  }
  return callbackPort;
}

/** Every provider with its configuration state, capabilities and account. */
function overview() {
  const connected = accounts.listRaw();
  const byProvider = {};
  for (const account of connected) byProvider[account.provider] = account;

  return {
    port: callbackPort,
    encryption: vault.encryptionAvailable(),
    providers: registry.describeAll(byProvider).map((entry) => ({
      ...entry,
      account: byProvider[entry.id] ? accounts.toClient(byProvider[entry.id]) : null,
      redirectUri: callbackPort ? oauth.redirectUri(callbackPort, entry.id) : null
    }))
  };
}

/** Step one of connecting: opens the provider's own authorisation page. */
function beginConnection(providerId, { scopes } = {}) {
  const provider = registry.require(providerId);
  const config = registry.credentialsFor(providerId);
  const port = requirePort();

  if (provider.beginConnection) {
    // Adapters with a non-standard flow (the dev mock) handle themselves.
    return provider.beginConnection({ port, config });
  }

  const requested = scopes && scopes.length ? scopes : provider.oauth.scopes || [];
  return oauth.begin(provider, { port, config, scopes: requested });
}

/** Step two: called by the loopback callback route. */
async function completeConnection({ providerId, code, state, error, errorDescription }) {
  const provider = registry.require(providerId);

  if (error) {
    audit.record(audit.EVENTS.OAUTH_FAILED, { provider: providerId, error });
    throw new IntegrationError(CODES.AUTH_REQUIRED, {
      provider: providerId,
      message:
        errorDescription ||
        (error === 'access_denied'
          ? 'You declined the authorisation, so nothing was connected.'
          : 'The provider reported an authorisation error.')
    });
  }

  // Consuming the state first means a replayed or forged callback dies here.
  const entry = oauth.consumeState(state);
  if (entry.providerId !== providerId) {
    throw new IntegrationError(CODES.INVALID_STATE, {
      message: 'That authorisation belonged to a different provider.'
    });
  }
  if (!code) {
    throw new IntegrationError(CODES.INVALID_STATE, {
      message: 'The provider did not return an authorisation code.'
    });
  }

  const config = registry.credentialsFor(providerId);
  const tokens = await oauth.exchange(provider, {
    code,
    verifier: entry.verifier,
    redirectUri: entry.redirectUri,
    config
  });

  // Ask the provider who this actually is, rather than trusting the callback.
  const identity = await provider.getAccount({ accessToken: tokens.accessToken, config });

  const account = accounts.upsert(
    {
      provider: providerId,
      providerAccountId: identity.id,
      username: identity.username,
      displayName: identity.displayName,
      avatar: identity.avatar,
      scopes: tokens.scopes.length ? tokens.scopes : provider.oauth.scopes || [],
      metadata: identity.metadata || {}
    },
    tokens
  );

  return {
    accountId: account.id,
    provider: providerId,
    providerLabel: provider.label,
    username: account.username
  };
}

/** Drop an account: revoke remotely where possible, always erase locally. */
async function disconnect(accountId) {
  const account = accounts.requireOwned(accountId);
  const provider = registry.get(account.provider);
  let revoked = false;

  if (provider && !account.isMock) {
    const tokens = vault.get(accountId);
    if (tokens?.accessToken) {
      const config = registry.credentialsFor(account.provider);
      const result = await oauth.revoke(provider, { token: tokens.accessToken, config });
      revoked = Boolean(result.revoked);
    }
  }

  accounts.remove(accountId, { revoked });
  return { disconnected: true, revoked };
}

/**
 * Hand an adapter a live access token, refreshing first if it is about to die.
 * This is the only path from an account id to a usable credential.
 */
async function authorise(accountId) {
  const account = accounts.requireOwned(accountId);
  const provider = registry.require(account.provider);
  const config = registry.credentialsFor(account.provider);
  let tokens = accounts.credentials(accountId);

  if (accounts.isExpired(account)) {
    if (!tokens.refreshToken) {
      accounts.setStatus(accountId, accounts.STATUS.REAUTH_REQUIRED, 'The access token expired and there is no refresh token.');
      throw new IntegrationError(CODES.TOKEN_EXPIRED, { provider: account.provider });
    }
    try {
      const fresh = await oauth.refresh(provider, { refreshToken: tokens.refreshToken, config });
      vault.refreshed(accountId, fresh);
      tokens = vault.get(accountId);
      accounts.setStatus(accountId, accounts.STATUS.CONNECTED);
    } catch (error) {
      accounts.setStatus(accountId, accounts.STATUS.REAUTH_REQUIRED, 'Renewing the connection failed.');
      throw error;
    }
  }

  return { account, provider, config, accessToken: tokens.accessToken };
}

/** Capability lookup that does not need credentials. */
function capabilityFor(providerId, capability, account) {
  const provider = registry.get(providerId);
  if (!provider) return null;
  const matrix = account ? provider.capabilitiesFor(account) : provider.declaredCapabilities();
  return matrix[capability] || null;
}

module.exports = {
  registry,
  accounts,
  audit,
  vault,
  oauth,
  tools,
  // The AI reaches platforms through this and nothing else.
  execute: router.execute,
  checkAction: router.check,
  availableActions: router.availableActions,
  toolCatalogue: tools.catalogue,
  CAP_STATUS,
  setCallbackPort,
  overview,
  beginConnection,
  completeConnection,
  disconnect,
  authorise,
  capabilityFor
};
