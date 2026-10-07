const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("swh", {
  getGeometry: () => ipcRenderer.invoke("geometry"),
  getCursor: () => ipcRenderer.invoke("cursor"),
  closeInput: () => ipcRenderer.send("close-input"),
  onOpenInput: (cb) => ipcRenderer.on("open-input", () => cb()),
  onShortcut: (cb) => ipcRenderer.on("shortcut", (_e, s) => cb(s)),
});
