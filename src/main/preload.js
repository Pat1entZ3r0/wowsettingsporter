'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Each call resolves to the handler's value or rejects with its message.
async function call(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

const channels = [
  'app:info', 'settings:get', 'settings:set',
  'installs:detect', 'installs:flavorsAt', 'dialog:pickFolder', 'shell:openPath', 'clipboard:write',
  'wow:accounts', 'wow:characters', 'wow:addons', 'wow:addonsTxt', 'wow:isRunning',
  'snap:create', 'snap:list', 'snap:update', 'snap:delete', 'snap:export', 'snap:import', 'snap:openFolder',
  'target:inspect', 'apply:defaults', 'apply:plan', 'apply:run',
  'backups:list', 'backups:restore', 'backups:delete', 'backups:openFolder',
];

contextBridge.exposeInMainWorld('porter', {
  call: (channel, ...args) => {
    if (!channels.includes(channel)) return Promise.reject(new Error('Unknown call ' + channel));
    return call(channel, ...args);
  },
});
