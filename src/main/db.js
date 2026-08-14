const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

// Small JSON-file store. The dataset here is a few hundred records at most,
// so a real database would be more ceremony than it is worth.

let file = null;
let data = null;

function location() {
  if (!file) file = path.join(app.getPath('userData'), 'data.json');
  return file;
}

function load() {
  if (data) return data;
  try {
    data = JSON.parse(fs.readFileSync(location(), 'utf8'));
  } catch {
    data = { campaigns: [], ledger: {} };
  }
  if (!Array.isArray(data.campaigns)) data.campaigns = [];
  if (!data.ledger || typeof data.ledger !== 'object') data.ledger = {};
  if (!Array.isArray(data.watchlist)) data.watchlist = [];
  return data;
}

function persist() {
  const target = location();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Write to a sibling file first so a crash mid-write cannot truncate the real one.
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, target);
}

function createCampaign({ repo, pitch, audience, settings }) {
  const db = load();
  const campaign = {
    id: crypto.randomUUID(),
    repo,
    pitch: pitch || '',
    audience: audience || '',
    settings: settings || {},
    createdAt: new Date().toISOString(),
    status: 'running',
    analysis: null,
    stats: { discovered: 0, scored: 0, kept: 0 },
    log: [],
    targets: []
  };
  db.campaigns.unshift(campaign);
  // Keep history bounded — old campaigns are reference material, not an archive.
  if (db.campaigns.length > 25) db.campaigns.length = 25;
  persist();
  return campaign;
}

function getCampaign(id) {
  return load().campaigns.find((c) => c.id === id) || null;
}

function listCampaigns() {
  return load().campaigns.map((c) => ({
    id: c.id,
    repo: c.repo,
    createdAt: c.createdAt,
    status: c.status,
    stats: c.stats,
    targetCount: c.targets.length,
    sentCount: c.targets.filter((t) => t.status === 'sent' || t.status === 'replied').length
  }));
}

function updateCampaign(id, patch) {
  const campaign = getCampaign(id);
  if (!campaign) return null;
  Object.assign(campaign, patch);
  persist();
  return campaign;
}

function setTargets(id, targets) {
  const campaign = getCampaign(id);
  if (!campaign) return null;
  campaign.targets = targets;
  persist();
  return campaign;
}

function updateTarget(campaignId, targetId, patch) {
  const campaign = getCampaign(campaignId);
  if (!campaign) return null;
  const target = campaign.targets.find((t) => t.id === targetId);
  if (!target) return null;
  Object.assign(target, patch);
  persist();
  return target;
}

function deleteCampaign(id) {
  const db = load();
  const before = db.campaigns.length;
  db.campaigns = db.campaigns.filter((c) => c.id !== id);
  persist();
  return db.campaigns.length < before;
}

// --- Contact ledger -------------------------------------------------------
// One entry per person, ever, across all campaigns. This is what stops the same
// developer being approached twice about the same project.

function ledgerHas(targetId) {
  return Boolean(load().ledger[targetId]);
}

function ledgerEntry(targetId) {
  return load().ledger[targetId] || null;
}

function recordContact(targetId, entry) {
  const db = load();
  db.ledger[targetId] = {
    at: new Date().toISOString(),
    ...entry
  };
  persist();
  return db.ledger[targetId];
}

function forgetContact(targetId) {
  const db = load();
  delete db.ledger[targetId];
  persist();
  return true;
}

function ledgerSize() {
  return Object.keys(load().ledger).length;
}

function contactedToday() {
  const day = new Date().toISOString().slice(0, 10);
  return Object.values(load().ledger).filter((entry) => (entry.at || '').slice(0, 10) === day).length;
}

// --- Watchlist ------------------------------------------------------------
// People handed over from the browser extension, waiting to be assessed.

function watchlist() {
  return load().watchlist;
}

function addToWatchlist(entry) {
  const db = load();
  const id = `github:${entry.login.toLowerCase()}`;
  if (db.watchlist.some((item) => item.id === id)) {
    return { added: false, contactedBefore: ledgerHas(id) };
  }
  db.watchlist.unshift({ id, status: 'pending', ...entry });
  if (db.watchlist.length > 200) db.watchlist.length = 200;
  persist();
  return { added: true, contactedBefore: ledgerHas(id) };
}

function updateWatchlistItem(id, patch) {
  const db = load();
  const item = db.watchlist.find((entry) => entry.id === id);
  if (!item) return null;
  Object.assign(item, patch);
  persist();
  return item;
}

function removeFromWatchlist(id) {
  const db = load();
  const before = db.watchlist.length;
  db.watchlist = db.watchlist.filter((entry) => entry.id !== id);
  persist();
  return db.watchlist.length < before;
}

module.exports = {
  watchlist,
  addToWatchlist,
  updateWatchlistItem,
  removeFromWatchlist,
  createCampaign,
  getCampaign,
  listCampaigns,
  updateCampaign,
  deleteCampaign,
  setTargets,
  updateTarget,
  ledgerHas,
  ledgerEntry,
  recordContact,
  forgetContact,
  ledgerSize,
  contactedToday
};
