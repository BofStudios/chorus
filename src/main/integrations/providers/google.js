// Google / Gmail — OAuth 2.0 for installed apps, PKCE, loopback redirect.
//
// This is the one provider in the set where outreach genuinely works as
// intended: gmail.send is a real, documented, permitted way to send a message
// to someone who has not contacted you first. It is also the one with real
// legal weight attached — CAN-SPAM, GDPR, and Google's own bulk sender rules
// apply to what goes out. The adapter enforces what it can (identity, headers,
// rate) and states the rest plainly.
//
// Docs: https://developers.google.com/gmail/api/guides/sending

const { SocialProvider, CAPABILITY } = require('../core/provider');
const { supported, unsupported, conditional } = require('../core/capabilities');
const registry = require('../core/registry');
const { IntegrationError, CODES, fromResponse } = require('../core/errors');

const GMAIL = 'https://gmail.googleapis.com/gmail/v1';
const OPENID = 'https://openidconnect.googleapis.com/v1';

class GoogleProvider extends SocialProvider {
  constructor() {
    super({
      id: 'google',
      label: 'Gmail',
      docs: 'https://developers.google.com/gmail/api/guides/sending',
      sdk: 'https://github.com/googleapis/google-api-nodejs-client',
      notes:
        'Sending works here without special approval, but gmail.send is a restricted scope: until your OAuth consent screen is verified, only accounts you add as test users can connect. Everything you send is subject to CAN-SPAM and GDPR — include a real identity and an opt-out.',
      credentials: {
        required: ['GOOGLE_CLIENT_ID'],
        optional: ['GOOGLE_CLIENT_SECRET'],
        clientId: 'GOOGLE_CLIENT_ID',
        clientSecret: 'GOOGLE_CLIENT_SECRET'
      },
      oauth: {
        authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        revokeUrl: 'https://oauth2.googleapis.com/revoke',
        scopes: [
          'openid',
          'email',
          'profile',
          'https://www.googleapis.com/auth/gmail.send'
        ],
        scopeSeparator: ' ',
        // Without these Google returns no refresh token on repeat consent.
        extraAuthParams: { access_type: 'offline', prompt: 'consent' }
      },
      limits: {
        perMinute: 60,
        burst: 10,
        // Gmail's per-user quota is generous; the sane limit for outreach is
        // social, not technical. One a minute keeps a human in the loop.
        perAction: { sendMessages: { perMinute: 1, burst: 3 } }
      },
      capabilities: {
        [CAPABILITY.PROFILE]: supported({ scopes: ['openid'] }),
        [CAPABILITY.SEARCH]: unsupported(
          'Gmail has no directory of people to search. Prospects come from research elsewhere; Gmail only delivers.'
        ),
        [CAPABILITY.READ_MESSAGES]: unsupported(
          'Chorus does not request read access to your mailbox. It only asks for permission to send.'
        ),
        [CAPABILITY.SEND_MESSAGES]: conditional(
          'Available once your Google Cloud OAuth consent screen lists this app. While it is unverified, only accounts added as test users can connect.',
          {
            scopes: ['https://www.googleapis.com/auth/gmail.send'],
            docs: 'https://developers.google.com/gmail/api/guides/sending'
          }
        )
      }
    });
  }

  async #call(accessToken, url, { method = 'GET', body } = {}) {
    let res;
    try {
      res = await fetch(url, {
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
          'Google refused the send. The account may not have granted the send permission, or the app’s consent screen is still unverified and this account is not a test user.';
      }
      if (error.code === CODES.RATE_LIMITED) this.limiter.penalise(error.retryAfterMs);
      throw error;
    }
    return payload;
  }

  async getAccount({ accessToken }) {
    const me = await this.#call(accessToken, `${OPENID}/userinfo`);
    return {
      id: me.sub,
      username: me.email || '',
      displayName: me.name || me.email || '',
      avatar: me.picture || '',
      metadata: { emailVerified: Boolean(me.email_verified) }
    };
  }

  async _getProfile(account) {
    const { accessToken } = await require('../index').authorise(account.id);
    const me = await this.#call(accessToken, `${OPENID}/userinfo`);
    return {
      platformUserId: me.sub,
      username: me.email,
      displayName: me.name || me.email,
      avatar: me.picture || '',
      profileUrl: ''
    };
  }

  async _createMessage(account, { recipient, body, subject, replyTo }) {
    const to = String(recipient).trim();
    // Sending to a malformed address wastes quota and looks like spam to Google.
    if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(to)) {
      throw new IntegrationError(CODES.INVALID_RECIPIENT, {
        provider: this.id,
        message: `"${to}" is not a valid email address.`
      });
    }
    return {
      provider: this.id,
      to,
      subject: (subject || 'Hello').slice(0, 200),
      text: body,
      replyTo: replyTo || ''
    };
  }

  async _sendMessage(account, payload) {
    const { accessToken, account: owner } = await require('../index').authorise(account.id);
    const from = owner.username;

    // RFC 5322. Non-ASCII subjects are encoded so they survive transport.
    const encodeHeader = (value) =>
      /^[\x20-\x7E]*$/.test(value)
        ? value
        : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;

    const headers = [
      `From: ${from}`,
      `To: ${payload.to}`,
      `Subject: ${encodeHeader(payload.subject)}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64'
    ];
    if (payload.replyTo) headers.push(`Reply-To: ${payload.replyTo}`);

    const mime = `${headers.join('\r\n')}\r\n\r\n${Buffer.from(payload.text, 'utf8').toString('base64')}`;
    const raw = Buffer.from(mime, 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const result = await this.#call(accessToken, `${GMAIL}/users/me/messages/send`, {
      method: 'POST',
      body: { raw }
    });

    return { providerMessageId: result.id || '', threadId: result.threadId || '' };
  }
}

module.exports = registry.register(new GoogleProvider());
