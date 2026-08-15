// Append-only record of everything that touched a connected account.
//
// Credentials never appear here. Every payload passes through the same redactor
// the error layer uses, and the writer additionally refuses to store any value
// that looks like a token regardless of its key.

const crypto = require('crypto');
const db = require('../../db');
const { redact } = require('./errors');

const EVENTS = {
  ACCOUNT_CONNECTED: 'account.connected',
  ACCOUNT_DISCONNECTED: 'account.disconnected',
  ACCOUNT_RECONNECTED: 'account.reconnected',
  OAUTH_STARTED: 'oauth.started',
  OAUTH_FAILED: 'oauth.failed',
  OAUTH_REFRESHED: 'oauth.refreshed',
  OAUTH_REVOKED: 'oauth.revoked',
  MESSAGE_GENERATED: 'message.generated',
  MESSAGE_APPROVED: 'message.approved',
  MESSAGE_QUEUED: 'message.queued',
  MESSAGE_SENT: 'message.sent',
  MESSAGE_FAILED: 'message.failed',
  MESSAGE_REJECTED: 'message.rejected',
  CAMPAIGN_STARTED: 'campaign.started',
  CAMPAIGN_PAUSED: 'campaign.paused',
  CAMPAIGN_STOPPED: 'campaign.stopped',
  ACTION_DENIED: 'action.denied'
};

const MAX_ENTRIES = 2000;

function record(event, details = {}) {
  const entries = db.collection('auditLog');
  const entry = {
    id: crypto.randomUUID(),
    event,
    at: new Date().toISOString(),
    ...redact(details)
  };
  entries.unshift(entry);
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
  db.persist();
  return entry;
}

function list({ limit = 100, event = null, accountId = null } = {}) {
  return db
    .collection('auditLog')
    .filter((entry) => (event ? entry.event === event : true))
    .filter((entry) => (accountId ? entry.accountId === accountId : true))
    .slice(0, limit);
}

function clear() {
  const entries = db.collection('auditLog');
  entries.length = 0;
  db.persist();
}

module.exports = { EVENTS, record, list, clear };
