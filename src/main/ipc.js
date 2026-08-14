const { ipcMain, shell, clipboard, app } = require('electron');
const { getStore } = require('./store');
const ai = require('./ai');
const github = require('./sources/github');
const research = require('./research');
const db = require('./db');
const http = require('./http');
const bridge = require('./bridge');

function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  });
}

function register(getWindow) {
  const store = getStore();

  const emit = (channel, payload) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  handle('app:info', () => ({
    version: app.getVersion(),
    userData: app.getPath('userData'),
    encryption: store.encryptionAvailable(),
    providers: Object.fromEntries(
      Object.entries(ai.PROVIDERS).map(([id, meta]) => [
        id,
        { label: meta.label, defaultModel: meta.defaultModel, signup: meta.signup || '' }
      ])
    ),
    tones: Object.entries(ai.TONES).map(([id, description]) => ({ id, description }))
  }));

  handle('settings:get', () => ({
    config: store.config,
    keys: Object.fromEntries(
      Object.entries(ai.PROVIDERS)
        .filter(([, meta]) => meta.keyName)
        .map(([id, meta]) => [id, Boolean(store.getSecret(meta.keyName))])
    ),
    githubToken: Boolean(store.getSecret('githubToken'))
  }));

  handle('settings:save', (patch) => store.save(patch));

  handle('settings:setKey', (provider, value) => {
    const meta = ai.PROVIDERS[provider];
    if (!meta?.keyName) throw new Error('Unknown provider.');
    store.setSecret(meta.keyName, (value || '').trim());
    return true;
  });

  handle('settings:setGithubToken', (value) => {
    store.setSecret('githubToken', (value || '').trim());
    return true;
  });

  handle('github:status', () => github.tokenStatus());

  handle('research:start', (payload) =>
    research.start(payload, (event) => emit('research:progress', event))
  );
  handle('research:cancel', () => research.cancel());
  handle('research:running', () => research.isRunning());

  handle('campaign:list', () => db.listCampaigns());
  handle('campaign:get', (id) => db.getCampaign(id));
  handle('campaign:delete', (id) => db.deleteCampaign(id));

  handle('target:update', (campaignId, targetId, patch) => {
    const allowed = {};
    for (const key of ['draft', 'notes', 'status']) {
      if (patch[key] !== undefined) allowed[key] = patch[key];
    }
    return db.updateTarget(campaignId, targetId, allowed);
  });

  // Marking someone as contacted is a manual act — the app never sends anything,
  // it only records that you did, so the same person is not approached twice.
  handle('target:markContacted', (campaignId, targetId, channel) => {
    const campaign = db.getCampaign(campaignId);
    const target = campaign?.targets.find((t) => t.id === targetId);
    if (!target) throw new Error('Target not found.');
    db.recordContact(targetId, { campaignId, repo: campaign.repo, channel: channel || target.channel });
    return db.updateTarget(campaignId, targetId, { status: 'sent', sentAt: new Date().toISOString() });
  });

  handle('target:unmarkContacted', (campaignId, targetId) => {
    db.forgetContact(targetId);
    return db.updateTarget(campaignId, targetId, { status: 'new', sentAt: null });
  });

  // --- extension bridge ---------------------------------------------------

  handle('bridge:status', () => bridge.status());
  handle('bridge:start', () => bridge.startBridge(() => emit('watchlist:changed', {})));
  handle('bridge:stop', () => {
    bridge.stopBridge();
    return true;
  });
  handle('bridge:rotate', () => bridge.rotateToken());

  handle('watchlist:list', () => db.watchlist());
  handle('watchlist:remove', (id) => db.removeFromWatchlist(id));
  handle('watchlist:assess', async (login, campaignId) => {
    const result = await research.assessOne({ login, campaignId });
    db.updateWatchlistItem(`github:${login.toLowerCase()}`, { status: 'assessed', score: result.score });
    return result;
  });

  // --- key validation -----------------------------------------------------
  // Sends the smallest possible request so the wizard can confirm a key works
  // before the user starts a run that would fail 40 times over.
  handle('settings:testKey', async (provider, rawKey) => {
    const meta = ai.PROVIDERS[provider];
    if (!meta?.keyName) throw new Error('That provider needs no key.');
    const key = (rawKey || '').trim() || store.getSecret(meta.keyName);
    if (!key) throw new Error('No key to test.');
    return ai.testKey(provider, key);
  });

  handle('ledger:stats', () => ({
    total: db.ledgerSize(),
    today: db.contactedToday(),
    cap: store.config.outreach.dailyDraftCap
  }));

  handle('rate:status', () => http.rateStatus());

  handle('clipboard:copy', (text) => {
    clipboard.writeText(String(text || ''));
    return true;
  });

  handle('shell:open', async (url) => {
    if (!/^https:\/\//i.test(url)) throw new Error('Refusing to open a non-https URL.');
    await shell.openExternal(url);
    return true;
  });
}

module.exports = { register };
