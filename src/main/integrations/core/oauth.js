// OAuth 2.0 authorization code flow for a desktop app (RFC 8252).
//
// The browser the user already trusts does the authorising; we never render a
// provider's login page inside the app and never see a password. The redirect
// comes back to a loopback address on this machine, which is the pattern the
// spec for native apps prescribes.
//
// PKCE is always used. Where a provider also requires a client secret, the
// exchange happens here in the main process — the secret never crosses IPC.

const crypto = require('crypto');
const { shell } = require('electron');
const audit = require('./audit');
const { IntegrationError, CODES } = require('./errors');

const STATE_TTL_MS = 10 * 60 * 1000;

// Pending authorisations, keyed by state. Never persisted: an interrupted flow
// should die with the process rather than linger as a replayable credential.
const pending = new Map();

function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function createPkce() {
  const verifier = base64url(crypto.randomBytes(64));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge, method: 'S256' };
}

function sweep() {
  const now = Date.now();
  for (const [state, entry] of pending) {
    if (now > entry.expiresAt) pending.delete(state);
  }
}

/** The loopback URI a provider must have registered. */
function redirectUri(port, provider) {
  return `http://127.0.0.1:${port}/oauth/callback/${provider}`;
}

/**
 * Begin an authorisation. Returns the URL that was opened so the UI can offer
 * it again if the browser did not come to the front.
 */
function begin(provider, { port, config, scopes = [], extraParams = {} }) {
  sweep();

  if (!provider.oauth?.authorizeUrl) {
    throw new IntegrationError(CODES.CAPABILITY_UNSUPPORTED, {
      provider: provider.id,
      message: `${provider.label} does not offer an OAuth flow in this build.`
    });
  }

  const missing = provider.missingCredentials(config);
  if (missing.length) {
    throw new IntegrationError(CODES.NOT_CONFIGURED, {
      provider: provider.id,
      message: `${provider.label} is missing ${missing.join(' and ')}. Add them in Settings → Integrations.`
    });
  }

  const state = base64url(crypto.randomBytes(32));
  const pkce = createPkce();
  const uri = redirectUri(port, provider.id);

  pending.set(state, {
    providerId: provider.id,
    verifier: pkce.verifier,
    redirectUri: uri,
    expiresAt: Date.now() + STATE_TTL_MS,
    createdAt: Date.now()
  });

  const url = new URL(provider.oauth.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config[provider.credentials.clientId]);
  url.searchParams.set('redirect_uri', uri);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', pkce.challenge);
  url.searchParams.set('code_challenge_method', pkce.method);
  if (scopes.length) url.searchParams.set('scope', scopes.join(provider.oauth.scopeSeparator || ' '));
  for (const [key, value] of Object.entries({ ...(provider.oauth.extraAuthParams || {}), ...extraParams })) {
    url.searchParams.set(key, value);
  }

  audit.record(audit.EVENTS.OAUTH_STARTED, { provider: provider.id, scopes });
  shell.openExternal(url.toString());

  return { state, url: url.toString(), redirectUri: uri };
}

/**
 * Validate a callback. Consumes the state so a replayed callback fails, which
 * is the point of holding it in the first place.
 */
function consumeState(state) {
  sweep();
  if (!state || !pending.has(state)) {
    throw new IntegrationError(CODES.INVALID_STATE, {
      message: 'That authorisation did not match a request this app started, or it expired. Try connecting again.'
    });
  }
  const entry = pending.get(state);
  pending.delete(state);
  return entry;
}

/** Exchange an authorization code for tokens. Runs only in the main process. */
async function exchange(provider, { code, verifier, redirectUri: uri, config }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: uri,
    client_id: config[provider.credentials.clientId],
    code_verifier: verifier
  });

  return tokenRequest(provider, body, config);
}

/** Swap a refresh token for a fresh access token. */
async function refresh(provider, { refreshToken, config }) {
  if (!provider.oauth?.tokenUrl || !refreshToken) {
    throw new IntegrationError(CODES.AUTH_REQUIRED, { provider: provider.id });
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: config[provider.credentials.clientId]
  });

  const tokens = await tokenRequest(provider, body, config);
  audit.record(audit.EVENTS.OAUTH_REFRESHED, { provider: provider.id });
  return tokens;
}

async function tokenRequest(provider, body, config) {
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
    'User-Agent': 'Chorus/0.1 (+https://github.com/BofStudios/chorus)'
  };

  // Providers differ on where the secret goes; both forms are standard.
  const secretKey = provider.credentials.clientSecret;
  const secret = secretKey ? config[secretKey] : '';
  if (secret) {
    if (provider.oauth.clientAuth === 'basic') {
      const pair = `${config[provider.credentials.clientId]}:${secret}`;
      headers.Authorization = `Basic ${Buffer.from(pair).toString('base64')}`;
    } else {
      body.set('client_secret', secret);
    }
  }

  let res;
  try {
    res = await fetch(provider.oauth.tokenUrl, { method: 'POST', headers, body: body.toString() });
  } catch (error) {
    throw new IntegrationError(CODES.NETWORK_ERROR, { provider: provider.id, cause: error });
  }

  const text = await res.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {
    // Some providers answer form-encoded on error.
    json = Object.fromEntries(new URLSearchParams(text));
  }

  if (!res.ok || json.error) {
    throw new IntegrationError(res.status === 401 ? CODES.AUTH_REQUIRED : CODES.PROVIDER_ERROR, {
      provider: provider.id,
      status: res.status,
      // The redactor strips the code and any token before this is logged.
      detail: json,
      message:
        json.error_description ||
        'The provider rejected the authorisation. Check the client ID, secret and redirect URI registered in its developer portal.'
    });
  }

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || '',
    tokenType: json.token_type || 'Bearer',
    scopes: (json.scope || '').split(/[\s,]+/).filter(Boolean),
    expiresAt: json.expires_in ? Date.now() + Number(json.expires_in) * 1000 : null
  };
}

/** Best-effort remote revocation. Local credentials are dropped regardless. */
async function revoke(provider, { token, config }) {
  if (!provider.oauth?.revokeUrl || !token) {
    return { revoked: false, reason: 'This provider has no revocation endpoint.' };
  }
  try {
    const body = new URLSearchParams({
      token,
      client_id: config[provider.credentials.clientId]
    });
    const secretKey = provider.credentials.clientSecret;
    if (secretKey && config[secretKey]) body.set('client_secret', config[secretKey]);

    const res = await fetch(provider.oauth.revokeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    audit.record(audit.EVENTS.OAUTH_REVOKED, { provider: provider.id, ok: res.ok });
    return { revoked: res.ok };
  } catch {
    return { revoked: false, reason: 'Could not reach the provider to revoke the token.' };
  }
}

function pendingCount() {
  sweep();
  return pending.size;
}

function cancelAll() {
  pending.clear();
}

module.exports = {
  begin,
  consumeState,
  exchange,
  refresh,
  revoke,
  redirectUri,
  createPkce,
  pendingCount,
  cancelAll,
  STATE_TTL_MS
};
