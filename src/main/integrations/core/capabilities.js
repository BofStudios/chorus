// What a provider can actually do — not what we wish it could do.
//
// Every entry in a provider's matrix is one of the statuses below, and anything
// that is not plainly SUPPORTED must carry a reason the UI can show the user.
// This file is the single place that decides whether an action is allowed to
// reach a provider adapter at all.

const CAPABILITY = {
  PROFILE: 'profile',
  SEARCH: 'search',
  READ_MESSAGES: 'readMessages',
  SEND_MESSAGES: 'sendMessages',
  COMMENTS: 'comments',
  POST: 'post'
};

const STATUS = {
  // The official API supports this and the connected account can use it now.
  SUPPORTED: 'supported',
  // Supported, but only under conditions the user must satisfy (account type,
  // paid tier, app review). `reason` explains which.
  CONDITIONAL: 'conditional',
  // The account is connected but did not grant the scope this needs.
  MISSING_SCOPE: 'missing-scope',
  // The provider's official API does not offer this at all. No workaround is
  // acceptable — if it is unsupported here, the action layer refuses it.
  UNSUPPORTED: 'unsupported'
};

// Only SUPPORTED lets an action through without further checks. CONDITIONAL is
// allowed to proceed but the caller must have satisfied the stated condition,
// which each adapter verifies against the live account.
const EXECUTABLE = new Set([STATUS.SUPPORTED, STATUS.CONDITIONAL]);

function capability(status, { reason = '', scopes = [], docs = '' } = {}) {
  if (!Object.values(STATUS).includes(status)) {
    throw new Error(`Unknown capability status: ${status}`);
  }
  if (status !== STATUS.SUPPORTED && !reason) {
    throw new Error(`Capability status "${status}" must explain itself with a reason.`);
  }
  return { status, reason, scopes, docs };
}

const supported = (options) => capability(STATUS.SUPPORTED, options);
const conditional = (reason, options = {}) => capability(STATUS.CONDITIONAL, { ...options, reason });
const unsupported = (reason, options = {}) => capability(STATUS.UNSUPPORTED, { ...options, reason });
const missingScope = (reason, options = {}) => capability(STATUS.MISSING_SCOPE, { ...options, reason });

function isExecutable(entry) {
  return Boolean(entry && EXECUTABLE.has(entry.status));
}

// Reduce a declared matrix against the scopes an account actually granted.
// A capability the provider supports but the user did not authorise becomes
// MISSING_SCOPE rather than silently failing at send time.
function resolve(matrix, grantedScopes = []) {
  const granted = new Set(grantedScopes);
  const resolved = {};

  for (const [name, entry] of Object.entries(matrix)) {
    if (!entry) continue;
    const needs = entry.scopes || [];
    const missing = needs.filter((scope) => !granted.has(scope));

    if (isExecutable(entry) && missing.length) {
      resolved[name] = {
        ...entry,
        status: STATUS.MISSING_SCOPE,
        reason: `The connected account did not grant ${missing.join(', ')}. Reconnect and approve it.`,
        missingScopes: missing
      };
    } else {
      resolved[name] = { ...entry };
    }
  }

  return resolved;
}

// A compact shape for the renderer: no scope internals, just what to show.
function summarise(resolved) {
  return Object.entries(resolved).map(([name, entry]) => ({
    capability: name,
    status: entry.status,
    reason: entry.reason,
    docs: entry.docs || ''
  }));
}

module.exports = {
  CAPABILITY,
  STATUS,
  capability,
  supported,
  conditional,
  unsupported,
  missingScope,
  isExecutable,
  resolve,
  summarise
};
