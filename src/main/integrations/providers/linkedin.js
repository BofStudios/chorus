// LinkedIn — OAuth 2.0 with OpenID Connect.
//
// The messaging API exists, but it is not open. Sending a LinkedIn message
// programmatically requires membership of a partner programme that is not
// available on request, and the scopes are not grantable by a standard app.
// The spec asked for LinkedIn "if the official API permissions available to the
// application support the required functionality" — they do not, so this
// adapter connects and identifies, and declares messaging unsupported.
//
// Docs: https://learn.microsoft.com/en-us/linkedin/

const { SocialProvider, CAPABILITY } = require('../core/provider');
const { supported, unsupported } = require('../core/capabilities');
const registry = require('../core/registry');
const { IntegrationError, CODES, fromResponse } = require('../core/errors');

const API = 'https://api.linkedin.com/v2';

class LinkedInProvider extends SocialProvider {
  constructor() {
    super({
      id: 'linkedin',
      label: 'LinkedIn',
      docs: 'https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow',
      sdk: 'https://learn.microsoft.com/en-us/linkedin/marketing/',
      notes:
        'LinkedIn does not grant messaging access to general developer applications — it is limited to approved partners. This connection can confirm your identity; it cannot send messages, and Chorus will not offer to.',
      credentials: {
        required: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'],
        clientId: 'LINKEDIN_CLIENT_ID',
        clientSecret: 'LINKEDIN_CLIENT_SECRET'
      },
      oauth: {
        authorizeUrl: 'https://www.linkedin.com/oauth/v2/authorization',
        tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
        scopes: ['openid', 'profile', 'email'],
        scopeSeparator: ' '
      },
      limits: { perMinute: 20, burst: 4 },
      capabilities: {
        [CAPABILITY.PROFILE]: supported({ scopes: ['profile'] }),
        [CAPABILITY.SEARCH]: unsupported(
          'People search is restricted to LinkedIn partner programmes and is not available to standard applications.'
        ),
        [CAPABILITY.READ_MESSAGES]: unsupported(
          'The messaging API is limited to approved partners.'
        ),
        [CAPABILITY.SEND_MESSAGES]: unsupported(
          'LinkedIn does not grant message-sending permissions to general applications. Connecting an account here will not enable outreach.',
          { docs: 'https://learn.microsoft.com/en-us/linkedin/marketing/' }
        )
      }
    });
  }

  async #call(accessToken, path) {
    let res;
    try {
      res = await fetch(`${API}${path}`, {
        headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'Chorus/0.1' }
      });
    } catch (error) {
      throw new IntegrationError(CODES.NETWORK_ERROR, { provider: this.id, cause: error });
    }
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = fromResponse(this.id, res.status, payload, res.headers);
      if (error.code === CODES.RATE_LIMITED) this.limiter.penalise(error.retryAfterMs);
      throw error;
    }
    return payload;
  }

  async getAccount({ accessToken }) {
    const me = await this.#call(accessToken, '/userinfo');
    return {
      id: me.sub,
      username: me.email || me.name || '',
      displayName: me.name || '',
      avatar: me.picture || '',
      metadata: { locale: me.locale || '' }
    };
  }

  async _getProfile(account) {
    const { accessToken } = await require('../index').authorise(account.id);
    const me = await this.#call(accessToken, '/userinfo');
    return {
      platformUserId: me.sub,
      username: me.email || '',
      displayName: me.name || '',
      avatar: me.picture || '',
      profileUrl: ''
    };
  }
}

module.exports = registry.register(new LinkedInProvider());
