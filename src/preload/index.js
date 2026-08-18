const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('chorus', {
  info: () => invoke('app:info'),

  auth: {
    state: () => invoke('auth:state'),
    signUp: (username, password, displayName) => invoke('auth:signUp', username, password, displayName),
    logIn: (username, password) => invoke('auth:logIn', username, password),
    logOut: () => invoke('auth:logOut'),
    changePassword: (current, next) => invoke('auth:changePassword', current, next),
    onChange: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('auth:changed', listener);
      return () => ipcRenderer.removeListener('auth:changed', listener);
    }
  },

  settings: {
    get: () => invoke('settings:get'),
    save: (patch) => invoke('settings:save', patch),
    setKey: (provider, value) => invoke('settings:setKey', provider, value),
    testKey: (provider, value) => invoke('settings:testKey', provider, value),
    setGithubToken: (value) => invoke('settings:setGithubToken', value)
  },

  bridge: {
    status: () => invoke('bridge:status'),
    start: () => invoke('bridge:start'),
    stop: () => invoke('bridge:stop'),
    rotate: () => invoke('bridge:rotate')
  },

  watchlist: {
    list: () => invoke('watchlist:list'),
    remove: (id) => invoke('watchlist:remove', id),
    assess: (login, campaignId) => invoke('watchlist:assess', login, campaignId),
    onChange: (callback) => {
      const listener = () => callback();
      ipcRenderer.on('watchlist:changed', listener);
      return () => ipcRenderer.removeListener('watchlist:changed', listener);
    }
  },

  github: {
    status: () => invoke('github:status')
  },

  research: {
    start: (payload) => invoke('research:start', payload),
    cancel: () => invoke('research:cancel'),
    running: () => invoke('research:running'),
    onProgress: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('research:progress', listener);
      return () => ipcRenderer.removeListener('research:progress', listener);
    }
  },

  campaigns: {
    list: () => invoke('campaign:list'),
    get: (id) => invoke('campaign:get', id),
    remove: (id) => invoke('campaign:delete', id)
  },

  targets: {
    update: (campaignId, targetId, patch) => invoke('target:update', campaignId, targetId, patch),
    markContacted: (campaignId, targetId, channel) =>
      invoke('target:markContacted', campaignId, targetId, channel),
    unmarkContacted: (campaignId, targetId) => invoke('target:unmarkContacted', campaignId, targetId)
  },

  ledger: {
    stats: () => invoke('ledger:stats')
  },

  rateStatus: () => invoke('rate:status'),
  copy: (text) => invoke('clipboard:copy', text),
  openExternal: (url) => invoke('shell:open', url)
});
