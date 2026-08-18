// The outreach queue.
//
// Every message that will ever leave this machine passes through here first, as
// a record with a state you can look at. Nothing is sent as a side effect of
// generating it: a draft has to be approved, and approval is a separate act.
//
// States, and the only legal moves between them:
//
//   draft ──approve──> approved ──enqueue──> queued ──> sending ──> sent
//     │                                                    │
//     └──skip──> skipped                                    └──> failed ──> queued (retry)
//
//   unsupported is terminal and set at generation time, when the channel a
//   message was written for turns out not to accept it.

const crypto = require('crypto');
const db = require('../db');
const audit = require('../integrations/core/audit');
const router = require('../integrations/core/router');

const STATE = {
  DRAFT: 'draft',
  APPROVED: 'approved',
  QUEUED: 'queued',
  SENDING: 'sending',
  SENT: 'sent',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  UNSUPPORTED: 'unsupported'
};

// A move not listed here is a bug, and rejecting it loudly beats a message
// quietly resurrecting itself after being skipped.
const TRANSITIONS = {
  [STATE.DRAFT]: [STATE.APPROVED, STATE.SKIPPED, STATE.UNSUPPORTED],
  [STATE.APPROVED]: [STATE.QUEUED, STATE.DRAFT, STATE.SKIPPED],
  [STATE.QUEUED]: [STATE.SENDING, STATE.APPROVED, STATE.SKIPPED],
  [STATE.SENDING]: [STATE.SENT, STATE.FAILED],
  [STATE.FAILED]: [STATE.QUEUED, STATE.SKIPPED],
  [STATE.SENT]: [],
  [STATE.SKIPPED]: [STATE.DRAFT],
  [STATE.UNSUPPORTED]: []
};

function all() {
  return db.collection('messages');
}

function find(id) {
  return all().find((message) => message.id === id) || null;
}

/**
 * Record a generated message. It lands as a draft — generating is not sending,
 * and the two are deliberately different verbs here.
 */
function create({ campaignId, prospect, tool, connectedAccountId, args, rationale, channel }) {
  const message = {
    id: crypto.randomUUID(),
    campaignId: campaignId || null,
    prospect: prospect || {},
    tool,
    connectedAccountId: connectedAccountId || null,
    args: args || {},
    rationale: rationale || '',
    channel: channel || '',
    state: STATE.DRAFT,
    attemptCount: 0,
    lastAttemptAt: null,
    nextAttemptAt: null,
    sentAt: null,
    errorCode: '',
    errorMessage: '',
    providerMessageId: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  all().unshift(message);
  db.persist();
  audit.record(audit.EVENTS.MESSAGE_GENERATED, {
    messageId: message.id,
    campaignId,
    tool,
    prospect: prospect?.username || ''
  });
  return message;
}

function transition(id, next, patch = {}) {
  const message = find(id);
  if (!message) return null;

  const allowed = TRANSITIONS[message.state] || [];
  if (!allowed.includes(next)) {
    throw new Error(`A message cannot go from ${message.state} to ${next}.`);
  }

  message.state = next;
  message.updatedAt = new Date().toISOString();
  Object.assign(message, patch);
  db.persist();
  return message;
}

/** Approve one message. Only a human does this — the worker never can. */
function approve(id) {
  const message = transition(id, STATE.APPROVED);
  if (message) {
    audit.record(audit.EVENTS.MESSAGE_APPROVED, { messageId: id, tool: message.tool });
  }
  return message;
}

function skip(id, reason = '') {
  return transition(id, STATE.SKIPPED, { errorMessage: reason });
}

function edit(id, args) {
  const message = find(id);
  if (!message) return null;
  if (message.state !== STATE.DRAFT && message.state !== STATE.APPROVED) {
    throw new Error('Only a draft or an approved message can be edited.');
  }
  message.args = { ...message.args, ...args };
  // Editing an approved message drops it back to draft: what was approved is
  // no longer what would be sent.
  if (message.state === STATE.APPROVED) message.state = STATE.DRAFT;
  message.updatedAt = new Date().toISOString();
  db.persist();
  return message;
}

/** Move an approved message into the sending queue. */
function enqueue(id) {
  const message = transition(id, STATE.QUEUED, { nextAttemptAt: Date.now() });
  if (message) audit.record(audit.EVENTS.MESSAGE_QUEUED, { messageId: id });
  return message;
}

/**
 * The next message the worker may attempt: queued, due, and belonging to a
 * campaign that is actually running.
 */
function claimNext({ campaignStates } = {}) {
  const now = Date.now();
  const candidate = all().find((message) => {
    if (message.state !== STATE.QUEUED) return false;
    if (message.nextAttemptAt && message.nextAttemptAt > now) return false;
    if (campaignStates && message.campaignId) {
      return campaignStates[message.campaignId] === 'running';
    }
    return true;
  });
  if (!candidate) return null;
  return transition(candidate.id, STATE.SENDING, {
    attemptCount: candidate.attemptCount + 1,
    lastAttemptAt: now
  });
}

function markSent(id, { providerMessageId, result }) {
  const message = transition(id, STATE.SENT, {
    providerMessageId: providerMessageId || '',
    sentAt: new Date().toISOString(),
    errorCode: '',
    errorMessage: ''
  });
  if (message) {
    audit.record(audit.EVENTS.MESSAGE_SENT, {
      messageId: id,
      tool: message.tool,
      providerMessageId: providerMessageId || ''
    });
    // The contact ledger is what stops the same person being written to twice.
    const key = message.prospect?.id || (message.prospect?.username ? `x:${message.prospect.username}` : null);
    if (key) {
      db.recordContact(key, {
        campaignId: message.campaignId,
        channel: message.channel,
        tool: message.tool
      });
    }
  }
  return { message, result };
}

function markFailed(id, { code, message: reason, retryAt }) {
  const message = transition(id, STATE.FAILED, {
    errorCode: code || 'unknown',
    errorMessage: reason || '',
    nextAttemptAt: retryAt || null
  });
  if (message) {
    audit.record(audit.EVENTS.MESSAGE_FAILED, { messageId: id, code, tool: message.tool });
  }
  return message;
}

/** Put a failed message back in line. */
function retry(id, delayMs = 0) {
  return transition(id, STATE.QUEUED, { nextAttemptAt: Date.now() + delayMs });
}

/**
 * Check a draft against the action layer without sending it. Runs at generation
 * time so a message written for a channel that will not accept it is marked
 * unsupported immediately rather than failing in the queue an hour later.
 */
async function validate(id) {
  const message = find(id);
  if (!message) return null;

  const verdict = await router.check(message.tool, {
    connectedAccountId: message.connectedAccountId,
    arguments: message.args
  });

  if (!verdict.ok) {
    transition(id, STATE.UNSUPPORTED, { errorMessage: verdict.reason });
  }
  return verdict;
}

function list({ campaignId, state, limit = 200 } = {}) {
  return all()
    .filter((message) => (campaignId ? message.campaignId === campaignId : true))
    .filter((message) => (state ? message.state === state : true))
    .slice(0, limit);
}

function counts(campaignId) {
  const scoped = all().filter((message) => (campaignId ? message.campaignId === campaignId : true));
  const out = Object.fromEntries(Object.values(STATE).map((state) => [state, 0]));
  for (const message of scoped) out[message.state] = (out[message.state] || 0) + 1;
  out.total = scoped.length;
  return out;
}

/** Approve everything still in draft for a campaign, in one act. */
function approveAll(campaignId) {
  const drafts = list({ campaignId, state: STATE.DRAFT });
  for (const message of drafts) approve(message.id);
  return drafts.length;
}

/** Stop a campaign's queued work without touching what was already sent. */
function pauseCampaign(campaignId) {
  const queued = list({ campaignId, state: STATE.QUEUED });
  for (const message of queued) transition(message.id, STATE.APPROVED, { nextAttemptAt: null });
  return queued.length;
}

function remove(id) {
  const messages = all();
  const index = messages.findIndex((message) => message.id === id);
  if (index === -1) return false;
  messages.splice(index, 1);
  db.persist();
  return true;
}

module.exports = {
  STATE,
  create,
  find,
  list,
  counts,
  approve,
  approveAll,
  skip,
  edit,
  enqueue,
  claimNext,
  markSent,
  markFailed,
  retry,
  validate,
  pauseCampaign,
  remove
};
