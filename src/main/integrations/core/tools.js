// The tool catalogue.
//
// This is the layer a broker would otherwise sell us: named, typed operations
// like GMAIL_SEND_EMAIL or REDDIT_SUBMIT_POST that a model can ask for by name,
// with a schema describing exactly what each one takes. Building it here rather
// than renting it means the access tokens stay in this machine's vault instead
// of a third party's database.
//
// A tool is declaration plus a handler. It names the capability it needs, and
// the router refuses to run it unless the connected account genuinely has that
// capability — so adding a tool cannot accidentally widen what a provider is
// allowed to do.

const { CAPABILITY } = require('./capabilities');
const { IntegrationError, CODES } = require('./errors');

const tools = new Map();

/**
 * @param {object} definition
 * @param {string} definition.slug        e.g. 'REDDIT_SUBMIT_POST'
 * @param {string} definition.provider    provider id
 * @param {string} definition.capability  capability the router must verify
 * @param {string} definition.summary     one line, shown to the user and model
 * @param {object} definition.input       { field: {type, required, max, pattern, description} }
 * @param {Function} definition.run       (provider, account, args) => result
 */
function define(definition) {
  for (const key of ['slug', 'provider', 'capability', 'summary', 'input', 'run']) {
    if (!definition[key]) throw new Error(`Tool definition is missing "${key}".`);
  }
  if (tools.has(definition.slug)) throw new Error(`Tool "${definition.slug}" already exists.`);
  tools.set(definition.slug, definition);
  return definition;
}

function get(slug) {
  return tools.get(slug) || null;
}

function list({ provider, capability } = {}) {
  return [...tools.values()]
    .filter((tool) => (provider ? tool.provider === provider : true))
    .filter((tool) => (capability ? tool.capability === capability : true));
}

/** The catalogue as the model should see it — names and shapes, no handlers. */
function catalogue({ provider } = {}) {
  return list({ provider }).map((tool) => ({
    slug: tool.slug,
    provider: tool.provider,
    capability: tool.capability,
    summary: tool.summary,
    input: Object.fromEntries(
      Object.entries(tool.input).map(([field, spec]) => [
        field,
        { type: spec.type, required: Boolean(spec.required), description: spec.description || '' }
      ])
    )
  }));
}

/**
 * Validate arguments against a tool's schema. Deliberately strict: unknown keys
 * are rejected rather than ignored, because a model inventing a parameter is a
 * signal worth surfacing, not smoothing over.
 */
function validate(tool, args = {}) {
  const clean = {};
  const problems = [];

  for (const key of Object.keys(args)) {
    if (!tool.input[key]) problems.push(`"${key}" is not a parameter of ${tool.slug}`);
  }

  for (const [field, spec] of Object.entries(tool.input)) {
    const value = args[field];

    if (value === undefined || value === null || value === '') {
      if (spec.required) problems.push(`"${field}" is required`);
      else if (spec.default !== undefined) clean[field] = spec.default;
      continue;
    }

    if (spec.type === 'string') {
      if (typeof value !== 'string') {
        problems.push(`"${field}" must be text`);
        continue;
      }
      if (spec.max && value.length > spec.max) {
        problems.push(`"${field}" is longer than ${spec.max} characters`);
        continue;
      }
      if (spec.pattern && !spec.pattern.test(value)) {
        problems.push(spec.patternMessage || `"${field}" is not in the expected format`);
        continue;
      }
      clean[field] = value;
    } else if (spec.type === 'number') {
      const number = Number(value);
      if (!Number.isFinite(number)) {
        problems.push(`"${field}" must be a number`);
        continue;
      }
      clean[field] = number;
    } else if (spec.type === 'boolean') {
      clean[field] = Boolean(value);
    } else {
      clean[field] = value;
    }
  }

  if (problems.length) {
    throw new IntegrationError(CODES.PROVIDER_ERROR, {
      provider: tool.provider,
      message: `${tool.slug} was called with invalid arguments: ${problems.join('; ')}.`
    });
  }

  return clean;
}

// --- the catalogue -------------------------------------------------------
// Every tool here maps onto an operation its provider genuinely supports.
// Instagram and LinkedIn have no send-message tool because those APIs have no
// send-message operation — the absence is the honest answer, not an oversight.

const EMAIL = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;

define({
  slug: 'GMAIL_SEND_EMAIL',
  provider: 'google',
  capability: CAPABILITY.SEND_MESSAGES,
  summary: 'Send an email from the connected Gmail account.',
  input: {
    to: { type: 'string', required: true, pattern: EMAIL, patternMessage: '"to" must be an email address', description: 'Recipient address' },
    subject: { type: 'string', required: true, max: 200, description: 'Subject line' },
    body: { type: 'string', required: true, max: 20000, description: 'Plain text body' },
    replyTo: { type: 'string', required: false, pattern: EMAIL, description: 'Optional Reply-To address' }
  },
  async run(provider, account, args) {
    const payload = await provider.createMessage(account, {
      recipient: args.to,
      body: args.body,
      subject: args.subject,
      replyTo: args.replyTo
    });
    return provider.sendMessage(account, payload);
  }
});

define({
  slug: 'REDDIT_SUBMIT_POST',
  provider: 'reddit',
  capability: CAPABILITY.POST,
  summary: 'Submit a post to a subreddit from the connected Reddit account.',
  input: {
    subreddit: { type: 'string', required: true, max: 50, description: 'Subreddit name, without r/' },
    title: { type: 'string', required: true, max: 300, description: 'Post title' },
    text: { type: 'string', required: false, max: 40000, description: 'Body for a text post' },
    url: { type: 'string', required: false, max: 2000, description: 'Link for a link post' }
  },
  run: (provider, account, args) => provider.post(account, args)
});

define({
  slug: 'REDDIT_CREATE_COMMENT',
  provider: 'reddit',
  capability: CAPABILITY.COMMENTS,
  summary: 'Reply to a Reddit post or comment.',
  input: {
    parentId: {
      type: 'string',
      required: true,
      pattern: /^t[135]_[a-z0-9]+$/i,
      patternMessage: '"parentId" must be a Reddit fullname such as t3_abc123',
      description: 'Fullname of the post or comment being answered'
    },
    text: { type: 'string', required: true, max: 10000, description: 'Comment body' }
  },
  run: (provider, account, args) => provider.comment(account, args)
});

define({
  slug: 'REDDIT_SEND_MESSAGE',
  provider: 'reddit',
  capability: CAPABILITY.SEND_MESSAGES,
  summary: 'Send a private message on Reddit. Heavily rate limited by design.',
  input: {
    to: { type: 'string', required: true, max: 40, description: 'Username, without u/' },
    subject: { type: 'string', required: false, max: 100, default: 'Hello', description: 'Subject' },
    body: { type: 'string', required: true, max: 10000, description: 'Message body' }
  },
  async run(provider, account, args) {
    const payload = await provider.createMessage(account, { recipient: args.to, body: args.body });
    payload.subject = args.subject || payload.subject;
    return provider.sendMessage(account, payload);
  }
});

define({
  slug: 'REDDIT_SEARCH_POSTS',
  provider: 'reddit',
  capability: CAPABILITY.SEARCH,
  summary: 'Search Reddit posts to find people discussing a topic.',
  input: {
    query: { type: 'string', required: true, max: 300, description: 'Search terms' },
    subreddit: { type: 'string', required: false, max: 50, description: 'Restrict to one subreddit' },
    limit: { type: 'number', required: false, default: 10, description: 'How many results' }
  },
  run: (provider, account, args) => provider.search(account, args)
});

define({
  slug: 'INSTAGRAM_PUBLISH_MEDIA',
  provider: 'instagram',
  capability: CAPABILITY.POST,
  summary: 'Publish an image to the connected Instagram Professional account.',
  input: {
    imageUrl: {
      type: 'string',
      required: true,
      max: 2000,
      pattern: /^https:\/\//i,
      patternMessage: '"imageUrl" must be a public https URL — Instagram fetches the file itself',
      description: 'Publicly reachable image URL'
    },
    caption: { type: 'string', required: false, max: 2200, description: 'Caption' },
    isReel: { type: 'boolean', required: false, default: false, description: 'Publish as a Reel' }
  },
  run: (provider, account, args) => provider.post(account, args)
});

define({
  slug: 'INSTAGRAM_REPLY_COMMENT',
  provider: 'instagram',
  capability: CAPABILITY.COMMENTS,
  summary: 'Reply to a comment on your own Instagram media.',
  input: {
    parentId: { type: 'string', required: true, max: 60, description: 'Comment id being answered' },
    text: { type: 'string', required: true, max: 2200, description: 'Reply text' }
  },
  run: (provider, account, args) => provider.comment(account, args)
});

define({
  slug: 'X_SEND_DM',
  provider: 'x',
  capability: CAPABILITY.SEND_MESSAGES,
  summary: 'Send a direct message on X. Requires a paid API tier.',
  input: {
    to: { type: 'string', required: true, max: 40, description: 'Handle or numeric user id' },
    body: { type: 'string', required: true, max: 10000, description: 'Message text' }
  },
  async run(provider, account, args) {
    const payload = await provider.createMessage(account, { recipient: args.to, body: args.body });
    return provider.sendMessage(account, payload);
  }
});

define({
  slug: 'X_SEARCH_POSTS',
  provider: 'x',
  capability: CAPABILITY.SEARCH,
  summary: 'Search recent posts on X. Requires a paid API tier.',
  input: {
    query: { type: 'string', required: true, max: 512, description: 'Search query' },
    limit: { type: 'number', required: false, default: 10, description: 'How many results' }
  },
  run: (provider, account, args) => provider.search(account, args)
});

define({
  slug: 'X_GET_PROFILE',
  provider: 'x',
  capability: CAPABILITY.PROFILE,
  summary: 'Look up a public profile on X.',
  input: {
    username: { type: 'string', required: true, max: 40, description: 'Handle, with or without @' }
  },
  run: (provider, account, args) => provider.getProfile(account, args)
});

define({
  slug: 'REDDIT_GET_PROFILE',
  provider: 'reddit',
  capability: CAPABILITY.PROFILE,
  summary: 'Look up a public Reddit profile.',
  input: {
    username: { type: 'string', required: true, max: 40, description: 'Username, with or without u/' }
  },
  run: (provider, account, args) => provider.getProfile(account, args)
});

module.exports = { define, get, list, catalogue, validate, CAPABILITY };
