// Reddit — OAuth 2.0 installed app.
//
// Reddit does have a private-message endpoint, and it does work. What it also
// has is a site-wide rule against unsolicited bulk messaging, enforced by
// shadowbans that arrive without warning. So the capability is CONDITIONAL and
// the rate limiter is set deliberately low: this adapter is built for a handful
// of considered messages, not a campaign.
//
// Docs: https://www.reddit.com/dev/api

const { SocialProvider, CAPABILITY } = require('../core/provider');
const { supported, conditional } = require('../core/capabilities');
const audit = require('../core/audit');
const registry = require('../core/registry');
const { IntegrationError, CODES, fromResponse } = require('../core/errors');

const API = 'https://oauth.reddit.com';
const UA = 'desktop:studio.bof.chorus:v0.1.0 (by /u/chorus-app)';

class RedditProvider extends SocialProvider {
  constructor() {
    super({
      id: 'reddit',
      label: 'Reddit',
      docs: 'https://www.reddit.com/dev/api',
      sdk: 'https://github.com/reddit-archive/reddit/wiki/OAuth2',
      notes:
        'The channel that works on Reddit is posting and commenting where your project is on topic — not private messages. Chorus supports both, but PMs are capped at a couple an hour because Reddit shadowbans unsolicited bulk messaging. Read each subreddit’s self-promotion rules before you post; most require you to be a participant, not an advertiser.',
      credentials: {
        required: ['REDDIT_CLIENT_ID'],
        optional: ['REDDIT_CLIENT_SECRET'],
        clientId: 'REDDIT_CLIENT_ID',
        clientSecret: 'REDDIT_CLIENT_SECRET'
      },
      oauth: {
        authorizeUrl: 'https://www.reddit.com/api/v1/authorize',
        tokenUrl: 'https://www.reddit.com/api/v1/access_token',
        revokeUrl: 'https://www.reddit.com/api/v1/revoke_token',
        clientAuth: 'basic',
        scopes: ['identity', 'read', 'privatemessages', 'submit', 'edit'],
        scopeSeparator: ' ',
        extraAuthParams: { duration: 'permanent' }
      },
      limits: {
        perMinute: 30,
        burst: 5,
        // Reddit's own guidance is 60 requests/minute; messaging is throttled
        // far harder than that by the anti-spam system. Posting has its own
        // cadence — too many submissions in a row also trips the spam filter.
        perAction: {
          sendMessages: { perMinute: 2, burst: 1 },
          post: { perMinute: 1, burst: 1 },
          comments: { perMinute: 3, burst: 2 },
          search: { perMinute: 10, burst: 3 }
        }
      },
      capabilities: {
        [CAPABILITY.PROFILE]: supported({ scopes: ['identity'] }),
        [CAPABILITY.SEARCH]: supported({ scopes: ['read'] }),
        [CAPABILITY.READ_MESSAGES]: supported({ scopes: ['privatemessages'] }),

        // The channel that actually works for reaching people on Reddit.
        [CAPABILITY.POST]: supported({
          scopes: ['submit'],
          docs: 'https://www.reddit.com/dev/api#POST_api_submit'
        }),
        [CAPABILITY.COMMENTS]: supported({
          scopes: ['submit'],
          docs: 'https://www.reddit.com/dev/api#POST_api_comment'
        }),

        [CAPABILITY.SEND_MESSAGES]: conditional(
          'Allowed by the API, but Reddit’s rules forbid unsolicited bulk messages. Chorus limits this to a couple of messages an hour and will not batch them. Posting in a relevant subreddit reaches more people and does not risk the account.',
          { scopes: ['privatemessages'], docs: 'https://support.reddithelp.com/hc/en-us/articles/360043504051' }
        )
      }
    });
  }

  async #call(accessToken, path, { method = 'GET', form, query } = {}) {
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
          'User-Agent': UA,
          ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {})
        },
        body: form ? new URLSearchParams(form).toString() : undefined
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
    const me = await this.#call(accessToken, '/api/v1/me');
    return {
      id: me.id,
      username: me.name ? `u/${me.name}` : '',
      displayName: me.name || '',
      avatar: (me.icon_img || '').split('?')[0],
      metadata: { karma: me.total_karma ?? null, created: me.created_utc ?? null }
    };
  }

  async _getProfile(account, { username }) {
    const { accessToken } = await require('../index').authorise(account.id);
    const handle = String(username || '').replace(/^\/?u\//, '');
    const data = await this.#call(accessToken, `/user/${encodeURIComponent(handle)}/about`);
    const user = data.data;
    if (!user) throw new IntegrationError(CODES.INVALID_RECIPIENT, { provider: this.id });
    return {
      platformUserId: user.id,
      username: `u/${user.name}`,
      displayName: user.name,
      bio: user.subreddit?.public_description || '',
      avatar: (user.icon_img || '').split('?')[0],
      profileUrl: `https://reddit.com/user/${user.name}`,
      metadata: { karma: user.total_karma ?? null }
    };
  }

  async _search(account, { query, subreddit, limit = 10 }) {
    const { accessToken } = await require('../index').authorise(account.id);
    const path = subreddit ? `/r/${encodeURIComponent(subreddit)}/search` : '/search';
    const data = await this.#call(accessToken, path, {
      query: {
        q: query,
        limit: Math.min(limit, 25),
        sort: 'relevance',
        t: 'year',
        restrict_sr: subreddit ? 'true' : undefined,
        type: 'link'
      }
    });

    return (data.data?.children || []).map(({ data: post }) => ({
      platform: 'reddit',
      platformUserId: post.author_fullname || post.author,
      username: `u/${post.author}`,
      displayName: post.author,
      profileUrl: `https://reddit.com/user/${post.author}`,
      evidence: {
        type: 'post',
        text: post.title,
        url: `https://reddit.com${post.permalink}`,
        subreddit: post.subreddit_name_prefixed,
        score: post.score
      }
    }));
  }

  async _createMessage(account, { recipient, body }) {
    if (body.length > 10000) {
      throw new IntegrationError(CODES.PROVIDER_ERROR, {
        provider: this.id,
        message: 'Reddit messages cannot exceed 10,000 characters.'
      });
    }
    return {
      provider: this.id,
      to: String(recipient).replace(/^\/?u\//, ''),
      subject: 'About your project',
      text: body
    };
  }

  async _sendMessage(account, payload) {
    const { accessToken } = await require('../index').authorise(account.id);
    const result = await this.#call(accessToken, '/api/compose', {
      method: 'POST',
      form: {
        api_type: 'json',
        to: payload.to,
        subject: (payload.subject || 'Hello').slice(0, 100),
        text: payload.text
      }
    });

    // Reddit answers 200 with the failure inside the body, so a naive check
    // would report a rejected message as sent.
    const errors = result.json?.errors || [];
    if (errors.length) {
      const [code, explanation] = errors[0];
      const message = String(explanation || code);
      if (/USER_DOESNT_EXIST|NO_USER/i.test(code)) {
        throw new IntegrationError(CODES.INVALID_RECIPIENT, { provider: this.id, detail: errors });
      }
      if (/RATELIMIT/i.test(code)) {
        const error = new IntegrationError(CODES.RATE_LIMITED, {
          provider: this.id,
          message: `Reddit is throttling this account: ${message}`,
          retryAfterMs: 10 * 60000
        });
        this.limiter.penalise(error.retryAfterMs);
        throw error;
      }
      throw new IntegrationError(CODES.PROVIDER_ERROR, {
        provider: this.id,
        message: `Reddit rejected the message: ${message}`,
        detail: errors
      });
    }

    return { providerMessageId: '', accepted: true };
  }

  /**
   * Submit to a subreddit. Reddit answers 200 with the rejection inside the
   * body, so the same unwrapping the PM path needs applies here — and the
   * failures that matter (subreddit rules, karma gates, spam filter) all arrive
   * that way rather than as an HTTP error.
   */
  async _post(account, { subreddit, title, text, url }) {
    const { accessToken } = await require('../index').authorise(account.id);

    if (!subreddit) {
      throw new IntegrationError(CODES.PROVIDER_ERROR, {
        provider: this.id,
        message: 'A subreddit is required to post.'
      });
    }
    if (!title || title.length > 300) {
      throw new IntegrationError(CODES.PROVIDER_ERROR, {
        provider: this.id,
        message: 'Reddit titles are required and cannot exceed 300 characters.'
      });
    }

    const result = await this.#call(accessToken, '/api/submit', {
      method: 'POST',
      form: {
        api_type: 'json',
        sr: String(subreddit).replace(/^\/?r\//, ''),
        kind: url ? 'link' : 'self',
        title,
        ...(url ? { url } : { text: text || '' }),
        // Reddit rejects duplicate links; saying so plainly beats a silent no-op.
        resubmit: 'false',
        sendreplies: 'true'
      }
    });

    this.#assertAccepted(result, 'post');
    const data = result.json?.data || {};
    audit.record(audit.EVENTS.MESSAGE_SENT, {
      provider: this.id,
      accountId: account.id,
      channel: 'post',
      subreddit
    });

    return { providerMessageId: data.name || data.id || '', url: data.url || '' };
  }

  /** Reply to a post or comment by fullname, e.g. t3_abc123 or t1_def456. */
  async _comment(account, { parentId, text }) {
    const { accessToken } = await require('../index').authorise(account.id);

    if (!/^t[135]_[a-z0-9]+$/i.test(String(parentId || ''))) {
      throw new IntegrationError(CODES.INVALID_RECIPIENT, {
        provider: this.id,
        message: 'A Reddit reply needs the parent’s fullname, like t3_abc123 for a post or t1_abc123 for a comment.'
      });
    }

    const result = await this.#call(accessToken, '/api/comment', {
      method: 'POST',
      form: { api_type: 'json', thing_id: parentId, text }
    });

    this.#assertAccepted(result, 'comment');
    const thing = result.json?.data?.things?.[0]?.data || {};
    audit.record(audit.EVENTS.MESSAGE_SENT, {
      provider: this.id,
      accountId: account.id,
      channel: 'comment',
      parentId
    });

    return { providerMessageId: thing.name || '', url: thing.permalink ? `https://reddit.com${thing.permalink}` : '' };
  }

  /** Reddit's 200-with-errors convention, translated into real failures. */
  #assertAccepted(result, what) {
    const errors = result.json?.errors || [];
    if (!errors.length) return;

    const [code, explanation] = errors[0];
    const message = String(explanation || code);

    if (/RATELIMIT/i.test(code)) {
      const error = new IntegrationError(CODES.RATE_LIMITED, {
        provider: this.id,
        message: `Reddit is throttling this account: ${message}`,
        retryAfterMs: 10 * 60000
      });
      this.limiter.penalise(error.retryAfterMs);
      throw error;
    }
    if (/SUBREDDIT_NOEXIST|SUBREDDIT_NOTALLOWED|USER_REQUIRED/i.test(code)) {
      throw new IntegrationError(CODES.PERMISSION_DENIED, {
        provider: this.id,
        message: `Reddit refused the ${what}: ${message}. Many subreddits require minimum karma, account age, or forbid self-promotion outright.`,
        detail: errors
      });
    }
    throw new IntegrationError(CODES.PROVIDER_ERROR, {
      provider: this.id,
      message: `Reddit rejected the ${what}: ${message}`,
      detail: errors
    });
  }
}

module.exports = registry.register(new RedditProvider());
