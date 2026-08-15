// Typed integration errors.
//
// Two audiences: the user, who needs to know what to do next, and the log,
// which needs enough detail to debug. `message` is written for the user and
// never contains provider jargon; `detail` is for the log and is scrubbed of
// anything secret before it gets there.

const CODES = {
  NOT_CONFIGURED: 'not_configured',
  NOT_CONNECTED: 'not_connected',
  AUTH_REQUIRED: 'auth_required',
  TOKEN_EXPIRED: 'token_expired',
  PERMISSION_DENIED: 'permission_denied',
  CAPABILITY_UNSUPPORTED: 'capability_unsupported',
  RATE_LIMITED: 'rate_limited',
  INVALID_RECIPIENT: 'invalid_recipient',
  PROVIDER_ERROR: 'provider_error',
  NETWORK_ERROR: 'network_error',
  OWNERSHIP: 'ownership',
  INVALID_STATE: 'invalid_state'
};

const HUMAN = {
  [CODES.NOT_CONFIGURED]:
    'This provider has no developer credentials yet. Add them in Settings → Integrations before connecting an account.',
  [CODES.NOT_CONNECTED]: 'No account is connected for this provider.',
  [CODES.AUTH_REQUIRED]: 'This account needs to be authorised again. Reconnect it to continue.',
  [CODES.TOKEN_EXPIRED]: 'The connection to this account expired and could not be renewed. Reconnect it.',
  [CODES.PERMISSION_DENIED]:
    'This account does not have permission to perform that action. Reconnect it and approve the requested permissions, or check the permissions granted to your app in the provider’s developer portal.',
  [CODES.CAPABILITY_UNSUPPORTED]: 'This provider’s official API does not offer that action.',
  [CODES.RATE_LIMITED]: 'The provider is rate limiting this account. The queue will retry automatically.',
  [CODES.INVALID_RECIPIENT]: 'That recipient could not be reached — the account may be deleted, private, or misspelled.',
  [CODES.PROVIDER_ERROR]: 'The provider rejected the request. Nothing was sent.',
  [CODES.NETWORK_ERROR]: 'Could not reach the provider. Check your connection and try again.',
  [CODES.OWNERSHIP]: 'That connected account does not belong to you.',
  [CODES.INVALID_STATE]: 'The authorisation attempt did not match the one this app started. Start the connection again.'
};

// Anything that looks like a credential is replaced before it can reach a log.
const SECRET_KEYS =
  /(access[_-]?token|refresh[_-]?token|client[_-]?secret|client[_-]?id|authorization|auth|code|id[_-]?token|cookie|password|api[_-]?key|bearer|state|code[_-]?verifier)/i;

function redact(value, depth = 0) {
  if (depth > 6) return '[deep]';
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    // Bearer tokens and long opaque strings in free text.
    return value
      .replace(/Bearer\s+[\w.\-~+/]+=*/gi, 'Bearer [redacted]')
      .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[redacted]');
  }

  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

  if (typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = SECRET_KEYS.test(key) ? '[redacted]' : redact(val, depth + 1);
    }
    return out;
  }

  return value;
}

class IntegrationError extends Error {
  constructor(code, { message, detail, provider, status, retryAfterMs, cause } = {}) {
    super(message || HUMAN[code] || 'Something went wrong talking to the provider.');
    this.name = 'IntegrationError';
    this.code = code;
    this.provider = provider || '';
    this.status = status || null;
    this.retryAfterMs = retryAfterMs || null;
    // Scrubbed at construction so a careless log call cannot leak it later.
    this.detail = redact(detail);
    if (cause) this.cause = cause;
  }

  // Safe to hand to the renderer: no detail, no provider internals.
  toClient() {
    return {
      code: this.code,
      message: this.message,
      provider: this.provider,
      retryAfterMs: this.retryAfterMs
    };
  }

  get retryable() {
    return [CODES.RATE_LIMITED, CODES.NETWORK_ERROR, CODES.PROVIDER_ERROR].includes(this.code);
  }
}

// Map an HTTP response onto the right typed error.
function fromResponse(provider, status, body, headers) {
  const retryAfter = Number(headers?.get?.('retry-after'));
  const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null;

  if (status === 401) return new IntegrationError(CODES.AUTH_REQUIRED, { provider, status, detail: body });
  if (status === 403) return new IntegrationError(CODES.PERMISSION_DENIED, { provider, status, detail: body });
  if (status === 404) return new IntegrationError(CODES.INVALID_RECIPIENT, { provider, status, detail: body });
  if (status === 429) {
    return new IntegrationError(CODES.RATE_LIMITED, { provider, status, detail: body, retryAfterMs });
  }
  return new IntegrationError(CODES.PROVIDER_ERROR, { provider, status, detail: body, retryAfterMs });
}

module.exports = { CODES, IntegrationError, fromResponse, redact };
