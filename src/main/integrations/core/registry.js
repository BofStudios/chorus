// Provider registry and developer-credential resolution.
//
// Credentials resolve in one order, every time: environment variables win, then
// values the user saved in Settings. Production deployments set env vars and
// never touch the UI; a developer running locally can paste credentials instead.
// Nothing is hard-coded and nothing is committed.

const { getStore } = require('../../store');

const providers = new Map();

function register(provider) {
  if (providers.has(provider.id)) throw new Error(`Provider "${provider.id}" is already registered.`);
  providers.set(provider.id, provider);
  return provider;
}

function get(id) {
  return providers.get(id) || null;
}

function require_(id) {
  const provider = get(id);
  if (!provider) throw new Error(`Unknown provider "${id}".`);
  return provider;
}

function list() {
  return [...providers.values()];
}

/**
 * Developer credentials for a provider, e.g. { X_CLIENT_ID, X_CLIENT_SECRET }.
 * Read fresh each time so editing Settings takes effect without a restart.
 */
function credentialsFor(providerId) {
  const provider = require_(providerId);
  const store = getStore();
  const keys = new Set([
    ...(provider.credentials.required || []),
    ...(provider.credentials.optional || [])
  ]);

  const config = {};
  for (const key of keys) {
    const fromEnv = process.env[key];
    config[key] = fromEnv && fromEnv.trim() ? fromEnv.trim() : store.getSecret(`integration:${key}`) || '';
  }
  return config;
}

function setCredential(key, value) {
  getStore().setSecret(`integration:${key}`, (value || '').trim());
  return true;
}

/** Which keys are set, and from where — never the values themselves. */
function credentialStatus(providerId) {
  const provider = require_(providerId);
  const store = getStore();
  const keys = [...(provider.credentials.required || []), ...(provider.credentials.optional || [])];

  return keys.map((key) => {
    const fromEnv = Boolean(process.env[key] && process.env[key].trim());
    const fromStore = Boolean(store.getSecret(`integration:${key}`));
    return {
      key,
      set: fromEnv || fromStore,
      source: fromEnv ? 'environment' : fromStore ? 'settings' : null,
      required: (provider.credentials.required || []).includes(key)
    };
  });
}

/** Everything the Connected Accounts page needs, with no secrets in it. */
function describeAll(accountsByProvider = {}) {
  return list().map((provider) => {
    const config = credentialsFor(provider.id);
    const account = accountsByProvider[provider.id] || null;
    return {
      ...provider.describe(config, account),
      credentials: credentialStatus(provider.id)
    };
  });
}

module.exports = {
  register,
  get,
  require: require_,
  list,
  credentialsFor,
  setCredential,
  credentialStatus,
  describeAll
};
