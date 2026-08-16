// Composio — a broker rather than a single platform.
//
// The other adapters in this folder each speak to one API. Composio speaks to
// hundreds: it holds the OAuth apps, runs the consent flow, stores the tokens,
// and exposes each platform's operations as named tools it executes on your
// behalf. Connecting through it means not registering a developer app per
// platform, which is the tedious part of everything else here.
//
// The trade that comes with it, stated plainly because it is the user's to
// make: with a direct connection the access token sits encrypted on this
// machine. With Composio the token sits on Composio's servers and this app
// holds only a reference. That is a third party with standing access to the
// connected account.
//
// What it does not change is what each platform permits. Composio's Instagram
// toolkit is Meta's Graph API with a nicer wrapper — the same publish, comment
// and 24-hour reply operations, and still no endpoint for messaging a stranger.
// Capabilities here are read from Composio's own tool list, so this adapter
// reports whatever the platform actually exposes and never more.
//
// Docs: https://docs.composio.dev

const { SocialProvider, CAPABILITY } = require('../core/provider');
const { supported, conditional } = require('../core/capabilities');
const registry = require('../core/registry');
const audit = require('../core/audit');
const { IntegrationError, CODES } = require('../core/errors');

const API = 'https://backend.composio.dev/api/v3.1';

// Which Composio tool slugs map onto the capabilities Chorus understands.
// Anything unmatched is still listed for the user, just not routed by capability.
const CAPABILITY_PATTERNS = [
  [CAPABILITY.SEND_MESSAGES, /(SEND_MESSAGE|SEND_DM|SEND_EMAIL|CREATE_MESSAGE|SEND_MAIL)/i],
  [CAPABILITY.POST, /(CREATE_POST|SUBMIT|PUBLISH|CREATE_TWEET|POST_MEDIA|CREATE_MEDIA)/i],
  [CAPABILITY.COMMENTS, /(COMMENT|REPLY)/i],
  [CAPABILITY.SEARCH, /(SEARCH|FIND|LIST_.*USERS)/i],
  [CAPABILITY.PROFILE, /(GET_ME|GET_USER|GET_PROFILE|USER_INFO)/i],
  [CAPABILITY.READ_MESSAGES, /(GET_MESSAGES|LIST_MESSAGES|FETCH_MESSAGES|GET_CONVERSATION)/i]
];

class ComposioProvider extends SocialProvider {
  constructor() {
    super({
      id: 'composio',
      label: 'Composio',
      docs: 'https://docs.composio.dev',
      sdk: 'https://github.com/ComposioHQ/composio',
      notes:
        'Connects hundreds of platforms through one API key, and runs the OAuth for you so you do not have to register a developer app per platform. In exchange, Composio stores the access tokens on its servers rather than on this machine. It does not change what a platform allows — its Instagram toolkit is Meta’s API, so publishing and replies work and cold DMs still do not exist.',
      credentials: {
        required: ['COMPOSIO_API_KEY'],
        clientId: 'COMPOSIO_API_KEY'
      },
      // No local OAuth: Composio owns the consent flow and hands back a URL.
      oauth: { scopes: [] },
      limits: {
        perMinute: 60,
        burst: 10,
        perAction: {
          sendMessages: { perMinute: 4, burst: 2 },
          post: { perMinute: 2, burst: 1 },
          comments: { perMinute: 6, burst: 2 }
        }
      },
      // Broker-level defaults. The real answer for a given account comes from
      // toolkitCapabilities(), which asks Composio what the toolkit exposes.
      capabilities: {
        [CAPABILITY.PROFILE]: supported(),
        [CAPABILITY.SEARCH]: conditional(
          'Depends on the connected toolkit. Chorus reads the toolkit’s tool list to decide.'
        ),
        [CAPABILITY.SEND_MESSAGES]: conditional(
          'Depends on the connected toolkit and on what that platform permits. Gmail and Slack send; Instagram and LinkedIn do not offer outbound messaging to strangers regardless of how they are connected.'
        ),
        [CAPABILITY.POST]: conditional('Depends on the connected toolkit.'),
        [CAPABILITY.COMMENTS]: conditional('Depends on the connected toolkit.')
      }
    });
  }

  #key() {
    const config = registry.credentialsFor(this.id);
    const key = config.COMPOSIO_API_KEY;
    if (!key) {
      throw new IntegrationError(CODES.NOT_CONFIGURED, {
        provider: this.id,
        message: 'Add a Composio API key in Settings → Integrations. Get one at app.composio.dev.'
      });
    }
    return key;
  }

  async #call(path, { method = 'GET', body, query } = {}) {
    const url = new URL(`${API}${path}`);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
    }

    // Resolved before the try, so a missing key surfaces as "not configured"
    // rather than being swallowed and reported as a network failure.
    const key = this.#key();

    let res;
    try {
      res = await fetch(url.toString(), {
        method,
        headers: {
          'x-api-key': key,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'Chorus/0.1'
        },
        body: body ? JSON.stringify(body) : undefined
      });
    } catch (error) {
      throw new IntegrationError(CODES.NETWORK_ERROR, { provider: this.id, cause: error });
    }

    const payload = await res.json().catch(() => ({}));

    if (!res.ok) {
      // Composio returns { error: { message, slug, suggested_fix } }.
      const detail = payload.error || {};
      const slug = detail.slug || '';
      const human = [detail.message, detail.suggested_fix].filter(Boolean).join(' ');

      if (res.status === 401) {
        throw new IntegrationError(CODES.AUTH_REQUIRED, {
          provider: this.id,
          status: res.status,
          message: /APIKey/i.test(slug)
            ? 'Composio rejected the API key. Check it in Settings → Integrations.'
            : human || 'Composio rejected the request.',
          detail
        });
      }
      if (res.status === 429) {
        const error = new IntegrationError(CODES.RATE_LIMITED, {
          provider: this.id,
          status: res.status,
          detail,
          retryAfterMs: Number(res.headers.get('retry-after')) * 1000 || 60000
        });
        this.limiter.penalise(error.retryAfterMs);
        throw error;
      }
      throw new IntegrationError(CODES.PROVIDER_ERROR, {
        provider: this.id,
        status: res.status,
        message: human || `Composio returned ${res.status}.`,
        detail
      });
    }

    return payload;
  }

  // --- discovery -----------------------------------------------------------

  /** Platforms Composio can connect, for the picker in the connect modal. */
  async listToolkits({ limit = 100, search } = {}) {
    const data = await this.#call('/toolkits', { query: { limit, search } });
    const items = data.items || data.data || [];
    return items.map((toolkit) => ({
      slug: toolkit.slug || toolkit.name,
      name: toolkit.name || toolkit.slug,
      description: toolkit.meta?.description || toolkit.description || '',
      logo: toolkit.meta?.logo || toolkit.logo || '',
      categories: toolkit.meta?.categories || []
    }));
  }

  /**
   * What a toolkit actually exposes, derived from its tools rather than
   * assumed. This is what keeps the broker honest: if Composio lists no
   * outbound-message tool for a toolkit, the capability comes back unsupported.
   */
  async toolkitCapabilities(toolkitSlug) {
    const data = await this.#call('/tools', { query: { toolkit_slug: toolkitSlug, limit: 200 } });
    const tools = (data.items || data.data || []).map((tool) => ({
      slug: tool.slug || tool.name,
      name: tool.display_name || tool.name || tool.slug,
      description: tool.description || ''
    }));

    const matrix = {};
    for (const [capability, pattern] of CAPABILITY_PATTERNS) {
      const match = tools.find((tool) => pattern.test(tool.slug));
      matrix[capability] = match
        ? { status: 'supported', reason: '', tool: match.slug, scopes: [], docs: '' }
        : {
            status: 'unsupported',
            reason: `${toolkitSlug} exposes no tool for this action through Composio.`,
            scopes: [],
            docs: ''
          };
    }

    return { toolkit: toolkitSlug, tools, capabilities: matrix };
  }

  // --- connection ----------------------------------------------------------

  /**
   * Composio runs the consent flow. We ask it to start one and open the URL it
   * returns; the account becomes usable once its status reaches ACTIVE, which
   * `pollConnection` waits for rather than assuming.
   */
  async initiateConnection({ toolkitSlug, authConfigId, userId }) {
    if (!authConfigId) {
      throw new IntegrationError(CODES.NOT_CONFIGURED, {
        provider: this.id,
        message:
          `Create an auth config for ${toolkitSlug} in the Composio dashboard first, then paste its id here. That is where Composio stores the OAuth app for the platform.`
      });
    }

    const result = await this.#call('/connected_accounts', {
      method: 'POST',
      body: {
        auth_config: { id: authConfigId },
        connection: { user_id: userId || 'chorus-local-user' }
      }
    });

    const redirectUrl = result.connectionData?.val?.redirectUrl || result.redirect_url || result.redirectUrl || '';

    audit.record(audit.EVENTS.OAUTH_STARTED, { provider: this.id, toolkit: toolkitSlug });

    return {
      connectedAccountId: result.id,
      status: result.status || 'INITIATED',
      redirectUrl
    };
  }

  async connectionStatus(connectedAccountId) {
    const account = await this.#call(`/connected_accounts/${encodeURIComponent(connectedAccountId)}`);
    return {
      id: account.id,
      status: account.status,
      toolkit: account.toolkit?.slug || '',
      // Composio holds the credentials; nothing token-shaped is returned here.
      createdAt: account.created_at || ''
    };
  }

  /** Waits for ACTIVE, and reports the terminal failures rather than hanging. */
  async pollConnection(connectedAccountId, { attempts = 60, intervalMs = 2000 } = {}) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const state = await this.connectionStatus(connectedAccountId);
      if (state.status === 'ACTIVE') return state;
      if (state.status === 'FAILED') {
        throw new IntegrationError(CODES.AUTH_REQUIRED, {
          provider: this.id,
          message: 'Composio reported the authorisation failed. Try connecting again.'
        });
      }
      if (state.status === 'EXPIRED') {
        throw new IntegrationError(CODES.TOKEN_EXPIRED, { provider: this.id });
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new IntegrationError(CODES.AUTH_REQUIRED, {
      provider: this.id,
      message: 'The Composio authorisation was not completed in time. Start it again when you are ready.'
    });
  }

  async getAccount({ connectedAccountId }) {
    const state = await this.connectionStatus(connectedAccountId);
    return {
      id: state.id,
      username: state.toolkit ? `${state.toolkit} via Composio` : 'Composio connection',
      displayName: state.toolkit || 'Composio',
      avatar: '',
      metadata: { toolkit: state.toolkit, broker: 'composio' }
    };
  }

  async disconnectRemote(connectedAccountId) {
    await this.#call(`/connected_accounts/${encodeURIComponent(connectedAccountId)}`, { method: 'DELETE' });
    return { revoked: true };
  }

  // --- execution -----------------------------------------------------------

  /**
   * Run one named tool. The AI never reaches this directly — it asks the action
   * router for an operation, and the router resolves the account and picks the
   * tool. Arguments are passed through as given; Composio validates them.
   */
  async executeTool(account, toolSlug, args = {}) {
    const connectedAccountId = account.metadata?.composioAccountId || account.providerAccountId;

    const result = await this.#call(`/tools/execute/${encodeURIComponent(toolSlug)}`, {
      method: 'POST',
      body: {
        connected_account_id: connectedAccountId,
        arguments: args
      }
    });

    // Composio answers 200 with successful:false when the underlying platform
    // refused, so a naive check would report a failure as a send.
    if (result.successful === false || result.error) {
      throw new IntegrationError(CODES.PROVIDER_ERROR, {
        provider: this.id,
        message: `${toolSlug} failed: ${result.error || 'the platform rejected the request.'}`,
        detail: result
      });
    }

    return result.data ?? result;
  }

  async _sendMessage(account, payload) {
    const tool = payload.toolSlug || account.metadata?.sendTool;
    if (!tool) {
      throw new IntegrationError(CODES.CAPABILITY_UNSUPPORTED, {
        provider: this.id,
        message:
          'This Composio connection has no outbound-message tool. The platform it connects to does not offer one.'
      });
    }
    const data = await this.executeTool(account, tool, payload.arguments || {});
    audit.record(audit.EVENTS.MESSAGE_SENT, {
      provider: this.id,
      accountId: account.id,
      tool,
      toolkit: account.metadata?.toolkit || ''
    });
    return { providerMessageId: data?.id || data?.message_id || '', via: 'composio', tool };
  }

  async _post(account, payload) {
    const tool = payload.toolSlug || account.metadata?.postTool;
    if (!tool) {
      throw new IntegrationError(CODES.CAPABILITY_UNSUPPORTED, {
        provider: this.id,
        message: 'This Composio connection has no publishing tool.'
      });
    }
    const data = await this.executeTool(account, tool, payload.arguments || {});
    return { providerMessageId: data?.id || '', via: 'composio', tool };
  }

  async _comment(account, payload) {
    const tool = payload.toolSlug || account.metadata?.commentTool;
    if (!tool) {
      throw new IntegrationError(CODES.CAPABILITY_UNSUPPORTED, {
        provider: this.id,
        message: 'This Composio connection has no comment tool.'
      });
    }
    const data = await this.executeTool(account, tool, payload.arguments || {});
    return { providerMessageId: data?.id || '', via: 'composio', tool };
  }
}

module.exports = registry.register(new ComposioProvider());
