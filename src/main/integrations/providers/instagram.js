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
const audit = require('../core/audit');
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
        'Instagram is a broadcast channel, not an outreach one. With a Professional account this connection can publish to your own feed and answer comments and replies — which is how reach actually happens here. There is no API for messaging strangers and no API for finding them, so campaigns cannot target Instagram users.',
      credentials: {
        required: ['META_APP_ID', 'META_APP_SECRET'],
        clientId: 'META_APP_ID',
        clientSecret: 'META_APP_SECRET'
      },
      oauth: {
        authorizeUrl: 'https://www.instagram.com/oauth/authorize',
        tokenUrl: 'https://api.instagram.com/oauth/access_token',
        scopes: [
          'instagram_business_basic',
          'instagram_business_content_publish',
          'instagram_business_manage_comments',
          'instagram_business_manage_messages'
        ],
        scopeSeparator: ','
      },
      limits: {
        perMinute: 20,
        burst: 4,
        perAction: {
          sendMessages: { perMinute: 2, burst: 1 },
          // Meta allows 50 published posts per 24 hours; pacing well under it
          // keeps headroom for retries.
          post: { perMinute: 1, burst: 1 },
          comments: { perMinute: 4, burst: 2 }
        }
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

        // What Instagram does allow, and what reach on Instagram is actually
        // made of: publishing to your own audience and answering them.
        [CAPABILITY.POST]: conditional(
          'Requires a Professional (Business or Creator) account. Images must be reachable at a public URL — Meta fetches them, it does not accept uploads.',
          {
            scopes: ['instagram_business_content_publish'],
            docs: 'https://developers.facebook.com/docs/instagram-platform/content-publishing'
          }
        ),
        [CAPABILITY.COMMENTS]: conditional(
          'Requires a Professional account. Covers reading and replying to comments on your own media.',
          {
            scopes: ['instagram_business_manage_comments'],
            docs: 'https://developers.facebook.com/docs/instagram-platform/comment-moderation'
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

  async #call(accessToken, path, { query, method = 'GET' } = {}) {
    const url = new URL(`${GRAPH}${path}`);
    url.searchParams.set('access_token', accessToken);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
    }

    let res;
    try {
      res = await fetch(url.toString(), { method, headers: { 'User-Agent': 'Chorus/0.1' } });
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

  /**
   * Publish to the account's own feed. Two steps, because that is how Meta
   * models it: create a container pointing at a publicly reachable image, then
   * publish the container. The container can take a moment to become ready, so
   * its status is polled rather than assumed.
   */
  async _post(account, { imageUrl, caption, isReel = false }) {
    const { accessToken, account: owner } = await require('../index').authorise(account.id);

    if (owner.metadata?.accountType && owner.metadata.accountType === 'PERSONAL') {
      throw new IntegrationError(CODES.PERMISSION_DENIED, {
        provider: this.id,
        message:
          'Publishing needs a Professional account. Switch the Instagram account to Business or Creator in its settings, then reconnect it here.'
      });
    }
    if (!imageUrl || !/^https:\/\//i.test(imageUrl)) {
      throw new IntegrationError(CODES.PROVIDER_ERROR, {
        provider: this.id,
        message:
          'Instagram fetches media from a public https URL — it does not accept file uploads. Host the image somewhere reachable and pass its URL.'
      });
    }

    const container = await this.#call(accessToken, `/v21.0/${owner.providerAccountId}/media`, {
      method: 'POST',
      query: {
        image_url: imageUrl,
        caption: (caption || '').slice(0, 2200),
        media_type: isReel ? 'REELS' : undefined
      }
    });

    if (!container.id) {
      throw new IntegrationError(CODES.PROVIDER_ERROR, {
        provider: this.id,
        message: 'Instagram did not return a media container for this post.'
      });
    }

    await this.#awaitContainer(accessToken, container.id);

    const published = await this.#call(accessToken, `/v21.0/${owner.providerAccountId}/media_publish`, {
      method: 'POST',
      query: { creation_id: container.id }
    });

    audit.record(audit.EVENTS.MESSAGE_SENT, {
      provider: this.id,
      accountId: account.id,
      channel: 'post',
      mediaId: published.id || ''
    });

    return { providerMessageId: published.id || '', containerId: container.id };
  }

  /** Meta processes media asynchronously; publishing too early just fails. */
  async #awaitContainer(accessToken, containerId, { attempts = 10, intervalMs = 3000 } = {}) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const status = await this.#call(accessToken, `/v21.0/${containerId}`, {
        query: { fields: 'status_code,status' }
      });

      if (status.status_code === 'FINISHED') return true;
      if (status.status_code === 'ERROR' || status.status_code === 'EXPIRED') {
        throw new IntegrationError(CODES.PROVIDER_ERROR, {
          provider: this.id,
          message: `Instagram could not process the media: ${status.status || status.status_code}. Check that the image URL is publicly reachable and in a supported format.`
        });
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new IntegrationError(CODES.PROVIDER_ERROR, {
      provider: this.id,
      message: 'Instagram is still processing the media after 30 seconds. Nothing was published; try again shortly.'
    });
  }

  /** Reply to a comment on the account's own media. */
  async _comment(account, { parentId, text }) {
    const { accessToken } = await require('../index').authorise(account.id);

    if (!parentId) {
      throw new IntegrationError(CODES.INVALID_RECIPIENT, {
        provider: this.id,
        message: 'Replying needs the id of the comment being answered.'
      });
    }

    const result = await this.#call(accessToken, `/v21.0/${parentId}/replies`, {
      method: 'POST',
      query: { message: String(text || '').slice(0, 2200) }
    });

    audit.record(audit.EVENTS.MESSAGE_SENT, {
      provider: this.id,
      accountId: account.id,
      channel: 'comment',
      parentId
    });

    return { providerMessageId: result.id || '' };
  }

  /** Comments waiting on the account's recent media — the inbound side. */
  async listComments(account, { limit = 25 } = {}) {
    const { accessToken, account: owner } = await require('../index').authorise(account.id);
    const media = await this.#call(accessToken, `/v21.0/${owner.providerAccountId}/media`, {
      query: { fields: 'id,caption,permalink,timestamp', limit: 10 }
    });

    const collected = [];
    for (const item of media.data || []) {
      const comments = await this.#call(accessToken, `/v21.0/${item.id}/comments`, {
        query: { fields: 'id,text,username,timestamp,replies{id}', limit }
      });
      for (const comment of comments.data || []) {
        collected.push({
          id: comment.id,
          text: comment.text,
          username: comment.username ? `@${comment.username}` : '',
          at: comment.timestamp,
          answered: Boolean(comment.replies?.data?.length),
          mediaUrl: item.permalink
        });
      }
    }
    return collected.slice(0, limit);
  }

  // No _sendMessage implementation on purpose. The capability is unsupported,
  // so assertCapability rejects the action long before this point; leaving a
  // stub here would only invite someone to fill it in with a workaround.
}

module.exports = registry.register(new InstagramProvider());
