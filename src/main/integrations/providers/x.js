// X (Twitter) — API v2, OAuth 2.0 Authorization Code with PKCE.
//
// Capability reality check, because it decides what this adapter is allowed to
// do: direct messages and full search live behind paid API tiers. A free
// project can read a profile and little else. Rather than discovering that at
// send time, the matrix says so up front and the UI shows it.
//
// Docs: https://docs.x.com/x-api

const { SocialProvider, CAPABILITY } = require('../core/provider');
const { supported, conditional } = require('../core/capabilities');
const registry = require('../core/registry');
const { IntegrationError, CODES, fromResponse } = require('../core/errors');

const API = 'https://api.x.com/2';

class XProvider extends SocialProvider {
  constructor() {
    super({
      id: 'x',
      label: 'X',
      docs: 'https://docs.x.com/x-api/getting-started/about-x-api',
      sdk: 'https://github.com/xdevplatform/twitter-api-typescript-sdk',
      notes:
        'Direct messages and recent search require a paid API tier. On the free tier this connection can confirm who you are, but sending will be refused by X.',
      credentials: {
        required: ['X_CLIENT_ID'],
        optional: ['X_CLIENT_SECRET'],
        clientId: 'X_CLIENT_ID',
        clientSecret: 'X_CLIENT_SECRET'
      },
      oauth: {
        authorizeUrl: 'https://x.com/i/oauth2/authorize',
        tokenUrl: 'https://api.x.com/2/oauth2/token',
        revokeUrl: 'https://api.x.com/2/oauth2/revoke',
        clientAuth: 'basic',
        scopes: ['tweet.read', 'users.read', 'dm.write', 'offline.access'],
        scopeSeparator: ' '
      },
      limits: {
        perMinute: 30,
        burst: 5,
        perAction: {
          // X counts DMs strictly; stay well under and let the queue pace itself.
          sendMessages: { perMinute: 4, burst: 2 },
          search: { perMinute: 8, burst: 2 }
        }
      },
      capabilities: {
        [CAPABILITY.PROFILE]: supported({ scopes: ['users.read'] }),
        [CAPABILITY.SEARCH]: conditional(
          'Recent search requires a Basic tier project or higher. On the free tier X returns 403.',
          { scopes: ['tweet.read'], docs: 'https://docs.x.com/x-api/posts/search/introduction' }
        ),
        [CAPABILITY.READ_MESSAGES]: conditional(
          'Reading direct messages requires the dm.read scope and a paid tier.',
          { scopes: ['dm.read'], docs: 'https://docs.x.com/x-api/direct-messages/introduction' }
        ),
        [CAPABILITY.SEND_MESSAGES]: conditional(
          'Sending direct messages requires the dm.write scope and a paid API tier. The recipient must also accept messages from you.',
          { scopes: ['dm.write'], docs: 'https://docs.x.com/x-api/direct-messages/introduction' }
        )
      }
    });
  }

  async #call(accessToken, path, { method = 'GET', body, query } = {}) {
    const url = new URL(`${API}${path}`);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
    }

    let res;
    try {
      res = await fetch(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': 'Chorus/0.1'
        },
        body: body ? JSON.stringify(body) : undefined
      });
    } catch (error) {
      throw new IntegrationError(CODES.NETWORK_ERROR, { provider: this.id, cause: error });
    }

    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = fromResponse(this.id, res.status, payload, res.headers);
      if (res.status === 403) {
        error.message =
          'X refused this action for your API project. Direct messages and search need a paid tier and the matching scopes.';
      }
      if (error.code === CODES.RATE_LIMITED) this.limiter.penalise(error.retryAfterMs);
      throw error;
    }
    return payload;
  }

  async getAccount({ accessToken }) {
    const data = await this.#call(accessToken, '/users/me', {
      query: { 'user.fields': 'profile_image_url,username,name,verified' }
    });
    const user = data.data || {};
    return {
      id: user.id,
      username: user.username ? `@${user.username}` : '',
      displayName: user.name || '',
      avatar: user.profile_image_url || '',
      metadata: { verified: Boolean(user.verified) }
    };
  }

  async _getProfile(account, { username }) {
    const { accessToken } = await require('../index').authorise(account.id);
    const handle = String(username || '').replace(/^@/, '');
    const data = await this.#call(accessToken, `/users/by/username/${encodeURIComponent(handle)}`, {
      query: { 'user.fields': 'description,public_metrics,profile_image_url,url,verified' }
    });
    const user = data.data;
    if (!user) throw new IntegrationError(CODES.INVALID_RECIPIENT, { provider: this.id });
    return {
      platformUserId: user.id,
      username: `@${user.username}`,
      displayName: user.name,
      bio: user.description || '',
      avatar: user.profile_image_url || '',
      profileUrl: `https://x.com/${user.username}`,
      followers: user.public_metrics?.followers_count ?? null
    };
  }

  async _search(account, { query, limit = 10 }) {
    const { accessToken } = await require('../index').authorise(account.id);
    const data = await this.#call(accessToken, '/tweets/search/recent', {
      query: {
        query,
        max_results: Math.min(Math.max(limit, 10), 100),
        'tweet.fields': 'author_id,created_at,public_metrics',
        expansions: 'author_id',
        'user.fields': 'username,name,description,profile_image_url,public_metrics'
      }
    });

    const users = new Map((data.includes?.users || []).map((user) => [user.id, user]));
    return (data.data || []).map((post) => {
      const author = users.get(post.author_id) || {};
      return {
        platform: 'x',
        platformUserId: post.author_id,
        username: author.username ? `@${author.username}` : '',
        displayName: author.name || '',
        bio: author.description || '',
        profileUrl: author.username ? `https://x.com/${author.username}` : '',
        evidence: { type: 'post', text: post.text, url: `https://x.com/i/status/${post.id}` }
      };
    });
  }

  async _createMessage(account, { recipient, body }) {
    // X caps DMs at 10,000 characters; the practical limit for outreach is far
    // lower, but the adapter only enforces what the API enforces.
    if (body.length > 10000) {
      throw new IntegrationError(CODES.PROVIDER_ERROR, {
        provider: this.id,
        message: 'X direct messages cannot exceed 10,000 characters.'
      });
    }
    return { provider: this.id, recipientId: String(recipient).replace(/^@/, ''), text: body };
  }

  async _sendMessage(account, payload) {
    const { accessToken } = await require('../index').authorise(account.id);

    // The API addresses a conversation by numeric user id, so a handle has to
    // be resolved first — and a handle that does not resolve is a hard failure,
    // not something to guess at.
    let recipientId = payload.recipientId;
    if (!/^\d+$/.test(recipientId)) {
      const profile = await this._getProfile(account, { username: recipientId });
      recipientId = profile.platformUserId;
    }

    const result = await this.#call(
      accessToken,
      `/dm_conversations/with/${encodeURIComponent(recipientId)}/messages`,
      { method: 'POST', body: { text: payload.text } }
    );

    return {
      providerMessageId: result.data?.dm_event_id || '',
      conversationId: result.data?.dm_conversation_id || ''
    };
  }
}

module.exports = registry.register(new XProvider());
