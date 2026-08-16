// The contract every provider adapter implements.
//
// The base class owns the guard rails: before any adapter method runs, the
// requested capability is checked against what that provider declares and what
// the connected account actually granted. An adapter physically cannot execute
// an action its own matrix calls unsupported, because the call never reaches it.

const { CAPABILITY, STATUS, isExecutable, resolve, summarise } = require('./capabilities');
const { IntegrationError, CODES } = require('./errors');
const { limiterFor } = require('./rate-limit');

class SocialProvider {
  /**
   * @param {object} definition
   * @param {string} definition.id            stable key, e.g. 'x'
   * @param {string} definition.label         display name
   * @param {string} definition.docs          official developer documentation
   * @param {string} [definition.sdk]         official SDK repository, if one exists
   * @param {object} definition.credentials   which env/config keys this needs
   * @param {object} definition.oauth         authorize/token/revoke endpoints, scopes
   * @param {object} definition.capabilities  declared matrix
   * @param {object} [definition.limits]      rate limit configuration
   * @param {string} [definition.notes]       honest caveats shown in the UI
   */
  constructor(definition) {
    const required = ['id', 'label', 'docs', 'credentials', 'capabilities'];
    for (const key of required) {
      if (!definition[key]) throw new Error(`Provider definition is missing "${key}".`);
    }
    Object.assign(this, definition);
    this.limiter = limiterFor(this.id, this.limits);
  }

  // --- configuration -------------------------------------------------------

  /** Developer credentials present? Without them nothing can be connected. */
  isConfigured(config) {
    return (this.credentials.required || []).every((key) => Boolean(config?.[key]));
  }

  missingCredentials(config) {
    return (this.credentials.required || []).filter((key) => !config?.[key]);
  }

  // --- capabilities --------------------------------------------------------

  /** The declared matrix, unreduced. */
  declaredCapabilities() {
    return this.capabilities;
  }

  /** The matrix reduced against one account's granted scopes. */
  capabilitiesFor(account) {
    return resolve(this.capabilities, account?.scopes || []);
  }

  capabilitySummary(account) {
    return summarise(account ? this.capabilitiesFor(account) : this.capabilities);
  }

  /**
   * Throws unless this capability may execute for this account. Every adapter
   * method routes through here — that is the whole point of the class.
   */
  assertCapability(name, account) {
    const matrix = account ? this.capabilitiesFor(account) : this.capabilities;
    const entry = matrix[name];

    if (!entry || entry.status === STATUS.UNSUPPORTED) {
      throw new IntegrationError(CODES.CAPABILITY_UNSUPPORTED, {
        provider: this.id,
        message: entry?.reason
          ? `${this.label}: ${entry.reason}`
          : `${this.label} does not offer that action through its official API.`
      });
    }

    if (entry.status === STATUS.MISSING_SCOPE) {
      throw new IntegrationError(CODES.PERMISSION_DENIED, {
        provider: this.id,
        message: `${this.label}: ${entry.reason}`
      });
    }

    return entry;
  }

  // --- account lifecycle ---------------------------------------------------
  // Adapters override what they support. The defaults refuse rather than
  // pretend, so a half-built adapter cannot silently look functional.

  async getAccount() {
    throw new IntegrationError(CODES.CAPABILITY_UNSUPPORTED, {
      provider: this.id,
      message: `${this.label} has not implemented account lookup.`
    });
  }

  /** Optional: providers that support programmatic revocation override this. */
  async revoke() {
    return { revoked: false, reason: 'This provider has no token revocation endpoint.' };
  }

  // --- capability-gated operations ----------------------------------------

  async getProfile(account, params) {
    this.assertCapability(CAPABILITY.PROFILE, account);
    return this.limiter.run('profile', () => this._getProfile(account, params), { maxWaitMs: 5000 });
  }

  async search(account, params) {
    this.assertCapability(CAPABILITY.SEARCH, account);
    return this.limiter.run('search', () => this._search(account, params), { maxWaitMs: 5000 });
  }

  async getConversation(account, params) {
    this.assertCapability(CAPABILITY.READ_MESSAGES, account);
    return this.limiter.run('readMessages', () => this._getConversation(account, params), { maxWaitMs: 5000 });
  }

  /**
   * Builds the provider-shaped payload without sending it. Kept separate from
   * sendMessage so the approval queue can validate and preview a message long
   * before anything leaves the machine.
   */
  async createMessage(account, { recipient, body }) {
    this.assertCapability(CAPABILITY.SEND_MESSAGES, account);
    if (!recipient) throw new IntegrationError(CODES.INVALID_RECIPIENT, { provider: this.id });
    if (!body || !body.trim()) {
      throw new IntegrationError(CODES.PROVIDER_ERROR, {
        provider: this.id,
        message: 'The message is empty.'
      });
    }
    return this._createMessage(account, { recipient, body });
  }

  async sendMessage(account, payload) {
    this.assertCapability(CAPABILITY.SEND_MESSAGES, account);
    return this.limiter.run('sendMessages', () => this._sendMessage(account, payload), { maxWaitMs: 0 });
  }

  /**
   * Publish to the account's own audience. This is the channel that actually
   * works on platforms whose DM APIs are closed — you are posting as yourself,
   * to people who chose to follow or subscribe.
   */
  async post(account, payload) {
    this.assertCapability(CAPABILITY.POST, account);
    return this.limiter.run('post', () => this._post(account, payload), { maxWaitMs: 0 });
  }

  /** Reply to a comment or thread the account can already see. */
  async comment(account, payload) {
    this.assertCapability(CAPABILITY.COMMENTS, account);
    return this.limiter.run('comments', () => this._comment(account, payload), { maxWaitMs: 0 });
  }

  async getUsage(account) {
    return this._getUsage ? this._getUsage(account) : { known: false };
  }

  // --- adapter hooks -------------------------------------------------------
  // Anything an adapter leaves unimplemented reports itself honestly.

  async _getProfile() {
    throw this.#notImplemented('profile lookup');
  }
  async _search() {
    throw this.#notImplemented('search');
  }
  async _getConversation() {
    throw this.#notImplemented('conversation reading');
  }
  async _createMessage(account, { recipient, body }) {
    return { recipient, body, provider: this.id };
  }
  async _sendMessage() {
    throw this.#notImplemented('message sending');
  }
  async _post() {
    throw this.#notImplemented('publishing');
  }
  async _comment() {
    throw this.#notImplemented('commenting');
  }

  #notImplemented(what) {
    return new IntegrationError(CODES.CAPABILITY_UNSUPPORTED, {
      provider: this.id,
      message: `${this.label}: ${what} is not implemented in this adapter.`
    });
  }

  // --- presentation --------------------------------------------------------

  describe(config, account) {
    return {
      id: this.id,
      label: this.label,
      docs: this.docs,
      sdk: this.sdk || '',
      notes: this.notes || '',
      configured: this.isConfigured(config),
      missingCredentials: this.missingCredentials(config),
      credentialKeys: this.credentials.required || [],
      scopes: this.oauth?.scopes || [],
      capabilities: this.capabilitySummary(account)
    };
  }
}

module.exports = { SocialProvider, CAPABILITY, STATUS, isExecutable };
