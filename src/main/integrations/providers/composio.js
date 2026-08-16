// Composio — a broker, sitting alongside the direct adapters rather than
// replacing them.
//
// The direct providers in this folder each need their own developer app: a
// Meta app for Instagram, a Reddit app, a Google Cloud project. That is an
// afternoon of portal work before the first request. Composio holds those OAuth
// apps already and exposes each platform's operations as named tools, so one
// API key reaches hundreds of services.
//
// The trade, which belongs to the user and is stated in `notes` so the UI shows
// it: a direct connection keeps the access token in this machine's vault, while
// a Composio connection keeps it on Composio's servers and leaves us holding a
// reference. Both are offered; neither is hidden.
//
// What it does not do is widen what a platform permits. Composio's Instagram
// toolkit is Meta's API. Capabilities here are read from the live tool list, so
// a toolkit with no outbound-message tool reports that honestly.
//
// Endpoints, response shapes and the auth header were verified against the live
// API rather than assumed.
//
// Docs: https://docs.composio.dev

const { SocialProvider, CAPABILITY } = require('../core/provider');
const { supported, conditional } = require('../core/capabilities');
const registry = require('../core/registry');
const audit = require('../core/audit');
const { IntegrationError, CODES } = require('../core/errors');

const API = 'https://backend.composio.dev/api/v3.1';

// Composio names tools PROVIDER_VERB. These map the verbs onto the capabilities
// Chorus gates on, so a toolkit's real tool list decides what it may do.
// Matched against the whole slug rather than anchored to the end: Composio
// repeats the platform name inside verbs (REDDIT_CREATE_REDDIT_POST), so an
// anchored pattern silently misses tools that are really there.
const CAPABILITY_PATTERNS = [
  [CAPABILITY.SEND_MESSAGES, /(SEND_TEXT_MESSAGE|SEND_MESSAGE|SEND_DM|SEND_EMAIL|SEND_MAIL|CREATE_MESSAGE)/i],
  [CAPABILITY.POST, /(CREATE_.*POST|SUBMIT_POST|PUBLISH|CREATE_TWEET|POST_.*MEDIA|CREATE_MEDIA|CREATE_POST)/i],
  [CAPABILITY.COMMENTS, /(POST_.*COMMENT|CREATE_COMMENT|REPLY_TO_COMMENT|COMMENT_REPLIES)/i],
  [CAPABILITY.SEARCH, /(SEARCH)/i],
  [CAPABILITY.PROFILE, /(GET_ME\b|GET_USER_INFO|GET_PROFILE|USER_ABOUT|GET_USER_BY_USERNAME)/i],
  [CAPABILITY.READ_MESSAGES, /(LIST_ALL_MESSAGES|GET_MESSAGES|LIST_MESSAGES|GET_CONVERSATION)/i]
];

class ComposioProvider extends SocialProvider {
  constructor() {
    super({
      id: 'composio',
      label: 'Composio',
      docs: 'https://docs.composio.dev',
      sdk: 'https://github.com/ComposioHQ/composio',
      notes:
        'One API key reaches hundreds of platforms, and Composio runs the OAuth so you do not register a developer app per service. In exchange it stores the access tokens on its servers rather than on this machine — the direct connections above keep them local. It does not change what a platform allows: its Instagram toolkit is Meta’s API, with the same limits.',
      credentials: {
        required: ['COMPOSIO_API_KEY'],
        clientId: 'COMPOSIO_API_KEY'
      },
      // Composio owns the consent flow; there is no local OAuth to run.
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
      capabilities: {
        [CAPABILITY.PROFILE]: supported(),
        [CAPABILITY.SEARCH]: conditional(
          'Depends on the connected toolkit. Chorus reads the toolkit’s live tool list to decide.'
        ),
        [CAPABILITY.SEND_MESSAGES]: conditional(
          'Depends on the connected toolkit and on what that platform permits. Gmail and Slack send; Instagram and LinkedIn have no outbound-message endpoint regardless of how they are connected.'
        ),
        [CAPABILITY.POST]: conditional('Depends on the connected toolkit.'),
        [CAPABILITY.COMMENTS]: conditional('Depends on the connected toolkit.')
      }
    });
  }

  #key() {
    const key = registry.credentialsFor(this.id).COMPOSIO_API_KEY;
    if (!key) {
      throw new IntegrationError(CODES.NOT_CONFIGURED, {
        provider: this.id,
        message: 'Add a Composio API key in Settings → Integrations, or set COMPOSIO_API_KEY. Get one at app.composio.dev.'
      });
    }
    return key;
  }

  async #call(path, { method = 'GET', body, query } = {}) {
    // Resolved before the try so a missing key reads as "not configured"
    // rather than being caught and mislabelled a network failure.
    const key = this.#key();

    const url = new URL(`${API}${path}`);
    for (const [name, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(name, value);
    }

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
      // Shape: { error: { message, code, slug, suggested_fix } }
      const detail = payload.error || {};
      const human = [detail.message, detail.suggested_fix].filter(Boolean).join(' ');

      if (res.status === 401) {
        throw new IntegrationError(CODES.AUTH_REQUIRED, {
          provider: this.id,
          status: res.status,
          message: /APIKey/i.test(detail.slug || '')
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

  async listToolkits({ limit = 100, search } = {}) {
    const data = await this.#call('/toolkits', { query: { limit, search } });
    return (data.items || []).map((toolkit) => ({
      slug: toolkit.slug,
      name: toolkit.name,
      description: toolkit.meta?.description || '',
      logo: toolkit.meta?.logo || '',
      toolCount: toolkit.meta?.tools_count ?? null,
      authSchemes: toolkit.auth_schemes || [],
      // NO_AUTH toolkits work immediately; the rest need a connection first.
      needsAuth: !(toolkit.auth_schemes || []).includes('NO_AUTH'),
      managedAuth: (toolkit.composio_managed_auth_schemes || []).length > 0,
      categories: (toolkit.meta?.categories || []).map((category) => category.name || category.id)
    }));
  }

  async listTools(toolkitSlug, { limit = 200 } = {}) {
    const data = await this.#call('/tools', { query: { toolkit_slug: toolkitSlug, limit } });
    return (data.items || []).map((tool) => ({
      slug: tool.slug,
      name: tool.name || tool.slug,
      description: tool.description || '',
      input: tool.input_parameters || tool.parameters || null
    }));
  }

  /**
   * What a toolkit can actually do, derived from its tools rather than assumed.
   * This is what keeps a broker honest: no matching tool means no capability.
   */
  async toolkitCapabilities(toolkitSlug) {
    const tools = await this.listTools(toolkitSlug);
    const matrix = {};

    for (const [capability, pattern] of CAPABILITY_PATTERNS) {
      const match = tools.find((tool) => pattern.test(tool.slug));
      matrix[capability] = match
        ? { status: 'supported', reason: '', tool: match.slug }
        : {
            status: 'unsupported',
            reason: `${toolkitSlug} exposes no tool for this through Composio.`
          };
    }

    return { toolkit: toolkitSlug, tools, capabilities: matrix };
  }

  // --- connection ----------------------------------------------------------

  /**
   * Create the auth config for a toolkit. With Composio-managed OAuth this
   * needs no client id or secret of our own — that is the point of using it.
   */
  async createAuthConfig(toolkitSlug) {
    const data = await this.#call('/auth_configs', {
      method: 'POST',
      body: {
        toolkit: { slug: toolkitSlug },
        auth_config: { type: 'use_composio_managed_auth' }
      }
    });
    const config = data.auth_config || data;
    return { id: config.id, toolkit: toolkitSlug, name: config.name || '' };
  }

  async listAuthConfigs() {
    const data = await this.#call('/auth_configs', { query: { limit: 100 } });
    return (data.items || []).map((config) => ({
      id: config.id,
      toolkit: config.toolkit?.slug || '',
      name: config.name || '',
      managed: Boolean(config.is_composio_managed)
    }));
  }

  /** Start a connection; the returned URL is where the user authorises. */
  async initiateConnection({ toolkitSlug, authConfigId, userId = 'chorus-local-user' }) {
    let configId = authConfigId;
    if (!configId) {
      const existing = await this.listAuthConfigs();
      const match = existing.find((config) => config.toolkit === toolkitSlug);
      configId = match ? match.id : (await this.createAuthConfig(toolkitSlug)).id;
    }

    const result = await this.#call('/connected_accounts', {
      method: 'POST',
      body: { auth_config: { id: configId }, connection: { user_id: userId } }
    });

    audit.record(audit.EVENTS.OAUTH_STARTED, { provider: this.id, toolkit: toolkitSlug });

    return {
      connectedAccountId: result.id,
      status: result.status || 'INITIATED',
      redirectUrl:
        result.connection_data?.val?.redirectUrl ||
        result.connectionData?.val?.redirectUrl ||
        result.redirect_url ||
        ''
    };
  }

  async connectionStatus(connectedAccountId) {
    const account = await this.#call(`/connected_accounts/${encodeURIComponent(connectedAccountId)}`);
    return {
      id: account.id,
      status: account.status,
      toolkit: account.toolkit?.slug || '',
      createdAt: account.created_at || ''
    };
  }

  /** Wait for ACTIVE, and report terminal failures instead of hanging. */
  async pollConnection(connectedAccountId, { attempts = 90, intervalMs = 2000 } = {}) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const state = await this.connectionStatus(connectedAccountId);
      if (state.status === 'ACTIVE') return state;
      if (state.status === 'FAILED') {
        throw new IntegrationError(CODES.AUTH_REQUIRED, {
          provider: this.id,
          message: 'Composio reported the authorisation failed. Try connecting again.'
        });
      }
      if (state.status === 'EXPIRED') throw new IntegrationError(CODES.TOKEN_EXPIRED, { provider: this.id });
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
      metadata: { toolkit: state.toolkit, broker: 'composio', composioAccountId: state.id }
    };
  }

  async disconnectRemote(connectedAccountId) {
    await this.#call(`/connected_accounts/${encodeURIComponent(connectedAccountId)}`, { method: 'DELETE' });
    return { revoked: true };
  }

  // --- execution -----------------------------------------------------------

  /**
   * Run one named tool. NO_AUTH toolkits need no connected account, which is
   * why the id is optional here rather than required.
   */
  async executeTool(toolSlug, { connectedAccountId, arguments: args = {} } = {}) {
    const body = { arguments: args };
    if (connectedAccountId) body.connected_account_id = connectedAccountId;

    const result = await this.#call(`/tools/execute/${encodeURIComponent(toolSlug)}`, {
      method: 'POST',
      body
    });

    // Composio answers 200 with successful:false when the platform refused, so
    // a naive check would report a failure as a success.
    if (result.successful === false || result.error) {
      throw new IntegrationError(CODES.PROVIDER_ERROR, {
        provider: this.id,
        message: `${toolSlug} failed: ${result.error || 'the platform rejected the request.'}`,
        detail: result
      });
    }

    return result.data ?? result;
  }

  #toolFor(account, kind, payload) {
    const tool = payload.toolSlug || account.metadata?.[`${kind}Tool`];
    if (!tool) {
      throw new IntegrationError(CODES.CAPABILITY_UNSUPPORTED, {
        provider: this.id,
        message: `This Composio connection has no ${kind} tool — the platform it connects to does not offer one.`
      });
    }
    return tool;
  }

  async _sendMessage(account, payload) {
    const tool = this.#toolFor(account, 'send', payload);
    const data = await this.executeTool(tool, {
      connectedAccountId: account.metadata?.composioAccountId || account.providerAccountId,
      arguments: payload.arguments || {}
    });
    audit.record(audit.EVENTS.MESSAGE_SENT, {
      provider: this.id,
      accountId: account.id,
      tool,
      toolkit: account.metadata?.toolkit || ''
    });
    return { providerMessageId: data?.id || data?.message_id || '', via: 'composio', tool };
  }

  async _post(account, payload) {
    const tool = this.#toolFor(account, 'post', payload);
    const data = await this.executeTool(tool, {
      connectedAccountId: account.metadata?.composioAccountId || account.providerAccountId,
      arguments: payload.arguments || {}
    });
    return { providerMessageId: data?.id || '', via: 'composio', tool };
  }

  async _comment(account, payload) {
    const tool = this.#toolFor(account, 'comment', payload);
    const data = await this.executeTool(tool, {
      connectedAccountId: account.metadata?.composioAccountId || account.providerAccountId,
      arguments: payload.arguments || {}
    });
    return { providerMessageId: data?.id || '', via: 'composio', tool };
  }

  async _search(account, payload) {
    const tool = payload.toolSlug || account.metadata?.searchTool;
    if (!tool) {
      throw new IntegrationError(CODES.CAPABILITY_UNSUPPORTED, {
        provider: this.id,
        message: 'This Composio connection has no search tool.'
      });
    }
    return this.executeTool(tool, {
      connectedAccountId: account.metadata?.composioAccountId || account.providerAccountId,
      arguments: payload.arguments || {}
    });
  }
}

module.exports = registry.register(new ComposioProvider());
