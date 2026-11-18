// Bridges the sandboxed overlay page to the hub's main process.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hub", {
  on: (channel, cb) => ipcRenderer.on(channel, (_e, data) => cb(data)),
  send: (channel, data) => ipcRenderer.send(channel, data),
});
