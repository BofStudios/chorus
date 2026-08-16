// The action router.
//
// This is the only way an action reaches a provider. The model does not build
// HTTP requests, does not choose an endpoint, and never sees a token: it names
// a tool and passes arguments, and everything below happens on this side of the
// boundary.
//
// Six gates, in this order, because each one assumes the previous passed:
//   1. the tool exists
//   2. the caller owns the connected account
//   3. the account belongs to the tool's provider
//   4. the provider genuinely supports the capability, for this account's scopes
//   5. the account is still usable (refreshing the token if that is enough)
//   6. arguments validate, and the rate limiter has room
//
// A failure at any gate is recorded and returned as a human sentence. Nothing
// half-runs.

const registry = require('./registry');
const accounts = require('./accounts');
const tools = require('./tools');
const audit = require('./audit');
const { isExecutable } = require('./capabilities');
const { IntegrationError, CODES } = require('./errors');

/**
 * @param {string} toolSlug
 * @param {object} params
 * @param {string} params.connectedAccountId
 * @param {object} params.arguments
 * @param {object} [params.context]  campaign/message ids for the audit trail
 */
async function execute(toolSlug, { connectedAccountId, arguments: args = {}, context = {} } = {}) {
  const tool = tools.get(toolSlug);

  // 1 — the tool exists.
  if (!tool) {
    audit.record(audit.EVENTS.ACTION_DENIED, { tool: toolSlug, reason: 'unknown-tool', ...context });
    throw new IntegrationError(CODES.CAPABILITY_UNSUPPORTED, {
      message: `There is no action called "${toolSlug}".`
    });
  }

  // 2 — ownership. Throws before anything else touches the record.
  const account = accounts.requireOwned(connectedAccountId);

  // 3 — the account is for the right provider. Without this, an id for a
  // connected Gmail account could be passed to a Reddit tool.
  if (account.provider !== tool.provider) {
    audit.record(audit.EVENTS.ACTION_DENIED, {
      tool: toolSlug,
      accountId: connectedAccountId,
      reason: 'provider-mismatch',
      ...context
    });
    throw new IntegrationError(CODES.PROVIDER_ERROR, {
      message: `${toolSlug} runs on ${tool.provider}, but that account is connected to ${account.provider}.`
    });
  }

  const provider = registry.require(tool.provider);

  // 4 — capability, resolved against the scopes this account actually granted.
  const entry = provider.capabilitiesFor(account)[tool.capability];
  if (!isExecutable(entry)) {
    audit.record(audit.EVENTS.ACTION_DENIED, {
      tool: toolSlug,
      accountId: connectedAccountId,
      capability: tool.capability,
      status: entry?.status || 'unknown',
      ...context
    });
    throw new IntegrationError(
      entry?.status === 'missing-scope' ? CODES.PERMISSION_DENIED : CODES.CAPABILITY_UNSUPPORTED,
      {
        provider: tool.provider,
        message: entry?.reason
          ? `${provider.label}: ${entry.reason}`
          : `${provider.label} does not support ${tool.capability}.`
      }
    );
  }

  // 5 — the account is usable. Disconnected or expired accounts stop here
  // rather than producing a confusing 401 from the platform.
  if (account.status === accounts.STATUS.DISCONNECTED) {
    throw new IntegrationError(CODES.NOT_CONNECTED, { provider: tool.provider });
  }

  // 6 — arguments, then the provider's own rate limiter inside the adapter.
  const clean = tools.validate(tool, args);

  try {
    const result = await tool.run(provider, account, clean);
    audit.record(audit.EVENTS.MESSAGE_SENT, {
      tool: toolSlug,
      accountId: connectedAccountId,
      provider: tool.provider,
      capability: tool.capability,
      providerMessageId: result?.providerMessageId || '',
      ...context
    });
    return { ok: true, tool: toolSlug, result };
  } catch (error) {
    audit.record(audit.EVENTS.MESSAGE_FAILED, {
      tool: toolSlug,
      accountId: connectedAccountId,
      provider: tool.provider,
      code: error.code || 'unknown',
      ...context
    });
    throw error;
  }
}

/**
 * What the model may ask for right now, given what is connected. Tools whose
 * capability is unavailable are returned with a reason instead of being hidden,
 * so the model can explain the limit rather than silently ignoring a platform.
 */
function availableActions() {
  const connected = accounts.listRaw();

  return tools.catalogue().map((tool) => {
    const account = connected.find((entry) => entry.provider === tool.provider);
    if (!account) {
      return { ...tool, available: false, reason: `No ${tool.provider} account is connected.`, connectedAccountId: null };
    }

    const provider = registry.get(tool.provider);
    const entry = provider?.capabilitiesFor(account)[tool.capability];

    return {
      ...tool,
      connectedAccountId: account.id,
      available: isExecutable(entry),
      reason: isExecutable(entry) ? '' : entry?.reason || 'Not supported by this provider.'
    };
  });
}

/** A dry run: every gate except the call itself. Used by the approval queue. */
async function check(toolSlug, { connectedAccountId, arguments: args = {} } = {}) {
  const tool = tools.get(toolSlug);
  if (!tool) return { ok: false, reason: `There is no action called "${toolSlug}".` };

  try {
    const account = accounts.requireOwned(connectedAccountId);
    if (account.provider !== tool.provider) {
      return { ok: false, reason: `${toolSlug} does not run on a ${account.provider} account.` };
    }
    const provider = registry.require(tool.provider);
    const entry = provider.capabilitiesFor(account)[tool.capability];
    if (!isExecutable(entry)) return { ok: false, reason: entry?.reason || 'Not supported.' };

    tools.validate(tool, args);
    const wait = provider.limiter.waitFor(tool.capability);
    return { ok: true, reason: '', waitMs: wait };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

module.exports = { execute, check, availableActions, catalogue: tools.catalogue };
