const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const DEFAULTS = {
  project: {
    repo: '',
    pitch: '',
    audience: ''
  },
  ai: {
    provider: 'offline',
    model: '',
    tone: 'peer',
    language: 'auto',
    maxChars: 700,
    extraInstructions: ''
  },
  research: {
    depth: 'standard',
    candidatePool: 120,
    scoreLimit: 40,
    contributorRepos: 10,
    minScore: 50,
    minFollowers: 0,
    activeWithinDays: 365,
    excludeOrganizations: true,
    requireContactChannel: false,
    sources: {
      neighbourRepos: true,
      contributors: true,
      userSearch: true,
      issueSearch: true,
      hackernews: true
    }
  },
  outreach: {
    skipAlreadyContacted: true,
    // 0 means no limit. There is nothing to throttle — the app never sends
    // anything, it only counts what you tell it you sent.
    dailyDraftCap: 0
  }
};

class Store {
  constructor() {
    this.dir = app.getPath('userData');
    this.file = path.join(this.dir, 'config.json');
    this.secretsFile = path.join(this.dir, 'secrets.bin');
    this.data = this.#readConfig();
    this.secrets = this.#readSecrets();
  }

  #readConfig() {
    try {
      return merge(structuredClone(DEFAULTS), JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {
      return structuredClone(DEFAULTS);
    }
  }

  #readSecrets() {
    try {
      const buf = fs.readFileSync(this.secretsFile);
      const json = safeStorage.isEncryptionAvailable()
        ? safeStorage.decryptString(buf)
        : buf.toString('utf8');
      return JSON.parse(json);
    } catch {
      return {};
    }
  }

  #writeSecrets() {
    // safeStorage binds the blob to this OS user account (DPAPI on Windows),
    // so tokens are not sitting in a readable file next to the config.
    const json = JSON.stringify(this.secrets);
    const buf = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(json)
      : Buffer.from(json, 'utf8');
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.secretsFile, buf);
  }

  get config() {
    return this.data;
  }

  save(patch) {
    this.data = merge(this.data, patch);
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    return this.data;
  }

  getSecret(key) {
    return this.secrets[key] || '';
  }

  setSecret(key, value) {
    if (!value) delete this.secrets[key];
    else this.secrets[key] = value;
    this.#writeSecrets();
  }

  encryptionAvailable() {
    return safeStorage.isEncryptionAvailable();
  }
}

function merge(base, patch) {
  if (!patch || typeof patch !== 'object') return base;
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      base[key] = merge(base[key] && typeof base[key] === 'object' ? base[key] : {}, value);
    } else if (value !== undefined) {
      base[key] = value;
    }
  }
  return base;
}

let instance = null;
module.exports = {
  getStore() {
    if (!instance) instance = new Store();
    return instance;
  },
  DEFAULTS
};
