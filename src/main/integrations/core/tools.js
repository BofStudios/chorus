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

// --- tools routed through Composio ---------------------------------------
//
// These reach platforms Chorus has no direct adapter for. Every slug below was
// read off Composio's live tool list, not guessed. Where a platform is missing
// from this section it is because Composio exposes no tool for it — Discord, for
// instance, has 23 tools and not one of them sends a message.

/**
 * A tool whose work happens inside a Composio connection. Beyond the router's
 * usual gates, this checks the connected account is for the right toolkit: a
 * Gmail connection must not be able to run a Slack tool just because both
 * arrived through the same broker.
 */
function defineComposio({ slug, toolkit, composioTool, capability, summary, input, mapArgs, caveat }) {
  return define({
    slug,
    provider: 'composio',
    capability,
    summary: caveat ? `${summary} ${caveat}` : summary,
    input,
    async run(provider, account, args) {
      const connectedToolkit = account.metadata?.toolkit || '';
      if (connectedToolkit && connectedToolkit !== toolkit) {
        throw new IntegrationError(CODES.PROVIDER_ERROR, {
          provider: 'composio',
          message: `${slug} needs a ${toolkit} connection, but that account is connected to ${connectedToolkit}.`
        });
      }
      const result = await provider.executeTool(composioTool, {
        connectedAccountId: account.metadata?.composioAccountId || account.providerAccountId,
        arguments: mapArgs ? mapArgs(args) : args
      });
      return {
        providerMessageId: result?.id || result?.message_id || result?.ts || '',
        via: 'composio',
        tool: composioTool,
        result
      };
    }
  });
}

defineComposio({
  slug: 'COMPOSIO_GMAIL_SEND_EMAIL',
  toolkit: 'gmail',
  composioTool: 'GMAIL_SEND_EMAIL',
  capability: CAPABILITY.SEND_MESSAGES,
  summary: 'Send an email through a Gmail account connected via Composio.',
  input: {
    to: { type: 'string', required: true, pattern: EMAIL, patternMessage: '"to" must be an email address', description: 'Recipient' },
    subject: { type: 'string', required: true, max: 200, description: 'Subject' },
    body: { type: 'string', required: true, max: 20000, description: 'Body text' }
  },
  mapArgs: (args) => ({ recipient_email: args.to, subject: args.subject, body: args.body })
});

defineComposio({
  slug: 'COMPOSIO_SLACK_POST_MESSAGE',
  toolkit: 'slack',
  composioTool: 'SLACK_CHAT_POST_MESSAGE',
  capability: CAPABILITY.SEND_MESSAGES,
  summary: 'Post a message to a Slack channel or user.',
  input: {
    channel: { type: 'string', required: true, max: 100, description: 'Channel id, #name, or user id for a DM' },
    text: { type: 'string', required: true, max: 40000, description: 'Message text' }
  },
  mapArgs: (args) => ({ channel: args.channel, text: args.text })
});

defineComposio({
  slug: 'COMPOSIO_X_SEND_DM',
  toolkit: 'twitter',
  composioTool: 'TWITTER_SEND_A_NEW_MESSAGE_TO_A_USER',
  capability: CAPABILITY.SEND_MESSAGES,
  summary: 'Send a direct message on X through a Composio connection.',
  caveat: 'Needs a paid X API tier; the free tier refuses DMs.',
  input: {
    participantId: { type: 'string', required: true, max: 40, description: 'Numeric X user id' },
    text: { type: 'string', required: true, max: 10000, description: 'Message text' }
  },
  mapArgs: (args) => ({ participant_id: args.participantId, text: args.text })
});

defineComposio({
  slug: 'COMPOSIO_WHATSAPP_SEND_MESSAGE',
  toolkit: 'whatsapp',
  composioTool: 'WHATSAPP_SEND_MESSAGE',
  capability: CAPABILITY.SEND_MESSAGES,
  summary: 'Send a WhatsApp Business message.',
  caveat:
    'Outside a 24-hour window opened by the recipient writing first, WhatsApp only accepts pre-approved template messages — free-form text to a stranger is rejected by Meta.',
  input: {
    to: {
      type: 'string',
      required: true,
      max: 20,
      pattern: /^\+?[0-9]{7,15}$/,
      patternMessage: '"to" must be a phone number in international format',
      description: 'Recipient phone number'
    },
    text: { type: 'string', required: true, max: 4096, description: 'Message text' }
  },
  mapArgs: (args) => ({ to: args.to, text: args.text })
});

// --- getting paid ---------------------------------------------------------
//
// Stripe has no single "send an invoice" call. A payable invoice is four steps:
// a customer, a line item, the invoice itself, then finalising it — and only
// after finalising does Stripe email it and expose a hosted page to pay on.
// Chaining them here means one tool call produces one payable invoice, and a
// failure halfway through reports which step failed instead of leaving a draft
// nobody knows about.
//
// Note what this does and does not touch: it creates a record in *your* Stripe
// account and asks Stripe to bill someone. No card number passes through
// Chorus, and nothing here can move money on its own — the recipient pays
// Stripe directly, on Stripe's page.

define({
  slug: 'STRIPE_ISSUE_INVOICE',
  provider: 'composio',
  capability: CAPABILITY.SEND_MESSAGES,
  summary:
    'Issue a payable invoice from your connected Stripe account and return its hosted payment page. Stripe emails the customer.',
  input: {
    email: {
      type: 'string',
      required: true,
      pattern: EMAIL,
      patternMessage: '"email" must be an email address',
      description: 'Who to bill'
    },
    name: { type: 'string', required: false, max: 200, description: 'Customer name' },
    description: { type: 'string', required: true, max: 300, description: 'What the invoice is for' },
    amount: { type: 'number', required: true, description: 'Amount in the smallest currency unit, e.g. 5000 = 50.00' },
    currency: { type: 'string', required: false, max: 3, default: 'usd', description: 'ISO currency code' },
    daysUntilDue: { type: 'number', required: false, default: 7, description: 'Payment terms in days' }
  },
  async run(provider, account, args) {
    const connectedAccountId = account.metadata?.composioAccountId || account.providerAccountId;
    const toolkit = account.metadata?.toolkit || '';
    if (toolkit && toolkit !== 'stripe') {
      throw new IntegrationError(CODES.PROVIDER_ERROR, {
        provider: 'composio',
        message: `Issuing an invoice needs a Stripe connection, but that account is connected to ${toolkit}.`
      });
    }

    const call = (tool, args_) =>
      provider.executeTool(tool, { connectedAccountId, arguments: args_ }).catch((error) => {
        throw new IntegrationError(CODES.PROVIDER_ERROR, {
          provider: 'composio',
          message: `Invoice failed at ${tool.replace('STRIPE_', '').toLowerCase()}: ${error.message}`,
          detail: error.detail
        });
      });

    // Amounts are integers in the smallest unit; a float here silently becomes
    // the wrong price, so it is rejected rather than rounded.
    if (!Number.isInteger(args.amount) || args.amount <= 0) {
      throw new IntegrationError(CODES.PROVIDER_ERROR, {
        provider: 'composio',
        message: 'The amount must be a whole number in the smallest currency unit — 5000 for 50.00, not 50.'
      });
    }

    const currency = (args.currency || 'usd').toLowerCase();

    const customer = await call('STRIPE_CREATE_CUSTOMER', {
      email: args.email,
      ...(args.name ? { name: args.name } : {})
    });
    const customerId = customer?.id;
    if (!customerId) {
      throw new IntegrationError(CODES.PROVIDER_ERROR, {
        provider: 'composio',
        message: 'Stripe did not return a customer id, so no invoice was created.'
      });
    }

    // The invoice is created before the item is attached only when the item
    // names the invoice; creating the item first lets Stripe attach it to the
    // next draft for this customer, which is the documented order.
    await call('STRIPE_CREATE_INVOICE_ITEM', {
      customer: customerId,
      amount: args.amount,
      currency,
      description: args.description
    });

    const invoice = await call('STRIPE_CREATE_INVOICE', {
      customer: customerId,
      collection_method: 'send_invoice',
      days_until_due: args.daysUntilDue ?? 7,
      description: args.description
    });
    const invoiceId = invoice?.id;
    if (!invoiceId) {
      throw new IntegrationError(CODES.PROVIDER_ERROR, {
        provider: 'composio',
        message: 'Stripe created no invoice id. Nothing was billed.'
      });
    }

    // Until it is finalised an invoice is a draft: not emailed, not payable.
    const finalised = await call('STRIPE_FINALIZE_INVOICE', { invoice: invoiceId });

    return {
      providerMessageId: invoiceId,
      via: 'composio',
      tool: 'STRIPE_ISSUE_INVOICE',
      customerId,
      invoiceId,
      status: finalised?.status || invoice?.status || 'unknown',
      amountDue: finalised?.amount_due ?? args.amount,
      currency,
      // The link to put in the outreach message.
      hostedInvoiceUrl: finalised?.hosted_invoice_url || invoice?.hosted_invoice_url || '',
      invoicePdf: finalised?.invoice_pdf || ''
    };
  }
});

module.exports = { define, defineComposio, get, list, catalogue, validate, CAPABILITY };
