// Instagram (Meta) — Instagram API with Instagram Login.
//
// This adapter exists mostly to tell the truth about what Instagram permits.
//
// Meta's messaging API is a *reply* channel. A business can answer someone who
// messaged them first, inside a 24-hour window, and that is the whole of it.
// There is no endpoint for messaging a stranger, and no user search endpoint to
// find one with. Cold outreach on Instagram is not a thing the official API
// does — so both capabilities are declared unsupported and the action layer
// refuses them before any request is built.
//
// Docs: https://developers.facebook.com/docs/instagram-platform

const { SocialProvider, CAPABILITY } = require('../core/provider');
const { supported, conditional, unsupported } = require('../core/capabilities');
const registry = require('../core/registry');
const { IntegrationError, CODES, fromResponse } = require('../core/errors');

const GRAPH = 'https://graph.instagram.com';

class InstagramProvider extends SocialProvider {
  constructor() {
    super({
      id: 'instagram',
      label: 'Instagram',
      docs: 'https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login',
      sdk: 'https://github.com/facebook/facebook-nodejs-business-sdk',
      notes:
        'Instagram has no API for messaging people who have not messaged you first, and no API for searching users. This connection can read your own profile and media, and reply to conversations someone else started within 24 hours. Cold outreach is not possible here — Chorus will not pretend otherwise.',
      credentials: {
        required: ['META_APP_ID', 'META_APP_SECRET'],
        clientId: 'META_APP_ID',
        clientSecret: 'META_APP_SECRET'
      },
      oauth: {
        authorizeUrl: 'https://www.instagram.com/oauth/authorize',
        tokenUrl: 'https://api.instagram.com/oauth/access_token',
        scopes: ['instagram_business_basic', 'instagram_business_manage_messages'],
        scopeSeparator: ','
      },
      limits: {
        perMinute: 20,
        burst: 4,
        perAction: { sendMessages: { perMinute: 2, burst: 1 } }
      },
      capabilities: {
        [CAPABILITY.PROFILE]: supported({ scopes: ['instagram_business_basic'] }),

        [CAPABILITY.SEARCH]: unsupported(
          'Instagram has no public endpoint for finding users. Prospects have to come from somewhere else.',
          { docs: 'https://developers.facebook.com/docs/instagram-platform' }
        ),

        [CAPABILITY.READ_MESSAGES]: conditional(
          'Requires a Professional account and the messaging permission, and only covers conversations someone started with you.',
          {
            scopes: ['instagram_business_manage_messages'],
            docs: 'https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api'
          }
        ),

        // The important one. Not "hard", not "needs review" — not offered.
        [CAPABILITY.SEND_MESSAGES]: unsupported(
          'Instagram only allows replying to someone who messaged you first, within 24 hours. There is no API for messaging a stranger, so outreach campaigns cannot run on Instagram.',
          {
            docs: 'https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api'
          }
        )
      }
    });
  }

  async #call(accessToken, path, { query } = {}) {
    const url = new URL(`${GRAPH}${path}`);
    url.searchParams.set('access_token', accessToken);
    for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, value);

    let res;
    try {
      res = await fetch(url.toString(), { headers: { 'User-Agent': 'Chorus/0.1' } });
    } catch (error) {
      throw new IntegrationError(CODES.NETWORK_ERROR, { provider: this.id, cause: error });
    }

    const payload = await res.json().catch(() => ({}));
    if (!res.ok || payload.error) {
      const error = fromResponse(this.id, res.status, payload, res.headers);
      if (error.code === CODES.RATE_LIMITED) this.limiter.penalise(error.retryAfterMs);
      throw error;
    }
    return payload;
  }

  async getAccount({ accessToken }) {
    const me = await this.#call(accessToken, '/v21.0/me', {
      query: { fields: 'id,username,account_type,profile_picture_url,name' }
    });
    return {
      id: me.id,
      username: me.username ? `@${me.username}` : '',
      displayName: me.name || me.username || '',
      avatar: me.profile_picture_url || '',
      metadata: { accountType: me.account_type || 'UNKNOWN' }
    };
  }

  async _getProfile(account) {
    const { accessToken } = await require('../index').authorise(account.id);
    const me = await this.#call(accessToken, '/v21.0/me', {
      query: { fields: 'id,username,account_type,media_count,followers_count,profile_picture_url,biography' }
    });
    return {
      platformUserId: me.id,
      username: me.username ? `@${me.username}` : '',
      displayName: me.username || '',
      bio: me.biography || '',
      avatar: me.profile_picture_url || '',
      profileUrl: me.username ? `https://instagram.com/${me.username}` : '',
      followers: me.followers_count ?? null,
      metadata: { accountType: me.account_type, mediaCount: me.media_count }
    };
  }

  // No _sendMessage implementation on purpose. The capability is unsupported,
  // so assertCapability rejects the action long before this point; leaving a
  // stub here would only invite someone to fill it in with a workaround.
}

module.exports = registry.register(new InstagramProvider());
