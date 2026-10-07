const { app, BrowserWindow, screen, ipcMain, globalShortcut } = require("electron");
const path = require("node:path");

const SHORTCUT = process.env.SWH_SHORTCUT || "Alt+Shift+Space";

app.dock?.hide();

app.whenReady().then(() => {
  const { x, y, width, height } = screen.getPrimaryDisplay().bounds;
  const win = new BrowserWindow({
    x, y, width, height,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    focusable: false,
    enableLargerThanScreen: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, "preload.js") },
  });
  win.setBounds({ x, y, width, height }); // ask again: macOS may have nudged it below the menu bar
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true); // click-through
  win.loadFile(path.join(__dirname, "overlay.html"));

  // macOS may still keep the window off the menu bar; report the real offset so the renderer can compensate.
  ipcMain.handle("geometry", () => {
    const b = win.getBounds();
    return { offX: b.x - x, offY: b.y - y, width, height };
  });

  ipcMain.handle("cursor", () => {
    const p = screen.getCursorScreenPoint();
    return { x: p.x - x, y: p.y - y };
  });

  // The window is normally unfocusable so it never steals keystrokes. The shortcut
  // makes it focusable just long enough to type a message to the agent.
  globalShortcut.register(SHORTCUT, () => {
    win.setFocusable(true);
    app.focus({ steal: true });
    win.focus();
    win.webContents.send("open-input");
  });

  ipcMain.on("close-input", () => {
    win.setFocusable(false);
    // Hand keyboard focus back to whatever app was in front.
    app.hide();
    setTimeout(() => win.showInactive(), 80);
  });

  win.webContents.on("did-finish-load", () => win.webContents.send("shortcut", SHORTCUT));
});

app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => app.quit());
