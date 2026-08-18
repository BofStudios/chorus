// Outreach campaigns.
//
// A campaign is the unit the worker obeys: it only picks up messages whose
// campaign is `running`. That makes pause and stop real rather than cosmetic —
// pausing does not race with an in-flight batch, it simply stops the next claim.

const crypto = require('crypto');
const db = require('../db');
const audit = require('../integrations/core/audit');

const STATUS = {
  DRAFT: 'draft',
  RESEARCHING: 'researching',
  REVIEW: 'ready-for-review',
  RUNNING: 'running',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  STOPPED: 'stopped',
  FAILED: 'failed'
};

// Sending only happens in `running`. Everything else is a hold of some kind.
const APPROVAL = {
  MANUAL: 'review-every-message',
  AUTOMATIC: 'send-approved-automatically'
};

function all() {
  return db.collection('outreachCampaigns');
}

function find(id) {
  return all().find((campaign) => campaign.id === id) || null;
}

function create({ name, product, audience, platforms, connectedAccountIds, approvalMode, researchCampaignId }) {
  const campaign = {
    id: crypto.randomUUID(),
    name: name || 'Untitled campaign',
    product: product || '',
    audience: audience || '',
    platforms: platforms || [],
    connectedAccountIds: connectedAccountIds || [],
    // Reviewing every message is the default. Automatic is opt-in, and even
    // then only sends what a human already approved.
    approvalMode: approvalMode === APPROVAL.AUTOMATIC ? APPROVAL.AUTOMATIC : APPROVAL.MANUAL,
    researchCampaignId: researchCampaignId || null,
    status: STATUS.DRAFT,
    stats: { generated: 0, approved: 0, sent: 0, failed: 0, replied: 0, positive: 0 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  all().unshift(campaign);
  db.persist();
  return campaign;
}

function setStatus(id, status, event) {
  const campaign = find(id);
  if (!campaign) return null;
  campaign.status = status;
  campaign.updatedAt = new Date().toISOString();
  db.persist();
  if (event) audit.record(event, { campaignId: id, name: campaign.name });
  return campaign;
}

const start = (id) => setStatus(id, STATUS.RUNNING, audit.EVENTS.CAMPAIGN_STARTED);
const pause = (id) => setStatus(id, STATUS.PAUSED, audit.EVENTS.CAMPAIGN_PAUSED);
const stop = (id) => setStatus(id, STATUS.STOPPED, audit.EVENTS.CAMPAIGN_STOPPED);
const complete = (id) => setStatus(id, STATUS.COMPLETED);

/** What the worker consults before claiming anything. */
function statusMap() {
  const map = {};
  for (const campaign of all()) map[campaign.id] = campaign.status;
  return map;
}

function recordResult(campaignId, kind) {
  if (!campaignId) return null;
  const campaign = find(campaignId);
  if (!campaign) return null;
  campaign.stats[kind] = (campaign.stats[kind] || 0) + 1;
  campaign.updatedAt = new Date().toISOString();
  db.persist();
  return campaign;
}

/** Replies are marked by hand — no API tells us a cold message landed well. */
function recordReply(campaignId, { positive = false } = {}) {
  const campaign = find(campaignId);
  if (!campaign) return null;
  campaign.stats.replied = (campaign.stats.replied || 0) + 1;
  if (positive) campaign.stats.positive = (campaign.stats.positive || 0) + 1;
  db.persist();
  return campaign;
}

function list() {
  return all().map((campaign) => ({ ...campaign }));
}

function remove(id) {
  const campaigns = all();
  const index = campaigns.findIndex((campaign) => campaign.id === id);
  if (index === -1) return false;
  campaigns.splice(index, 1);
  db.persist();
  return true;
}

module.exports = {
  STATUS,
  APPROVAL,
  create,
  find,
  list,
  start,
  pause,
  stop,
  complete,
  setStatus,
  statusMap,
  recordResult,
  recordReply,
  remove
};
