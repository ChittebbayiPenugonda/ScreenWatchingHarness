# Screen Buddy

A Claude Code plugin for macOS that lets Claude see your screen and show you things on it.

- **Look:** say "look at my screen" or "what's this error?" and Claude takes the screenshot itself. No more uploading screenshots into the chat.
- **Point:** turn on Screen Buddy and each Claude session gets its own small glowing buddy that flies to things on your screen, draws boxes around them and explains in a speech bubble.
- **Talk:** press Option+Shift+Space (or click a buddy) and type to it from any app.
- **Follow along:** the buddy keeps up as you click through an app, and gets out of the way when the screen changes.

## Requirements

- macOS (Apple silicon or Intel)
- [Claude Code](https://docs.claude.com/en/docs/claude-code), in the terminal, an IDE or the desktop app
- Node.js 20 or later with npm, on your PATH

## Install

**1. Add the plugin.** In Claude Code, run:

```
/plugin marketplace add ChittebbayiPenugonda/ScreenWatchingHarness
/plugin install screen-buddy@screen-buddy
```

**2. Install Electron.** Screen Buddy uses Electron to draw on your screen and capture it. In a terminal, run:

```bash
mkdir -p ~/Library/Application\ Support/screen-buddy/runtime && cd ~/Library/Application\ Support/screen-buddy/runtime && npm install electron@33.4.11
```

This downloads about 100 MB, once. (If you skip this step, the plugin does the same thing automatically the first time
it is used, which makes that first request slow.)

**3. Start a new Claude Code session** (or restart Claude Code) so it picks up the plugin.

**4. Allow Screen Recording.** In the new session, say "look at my screen". macOS asks for **Screen Recording**
permission for **Electron**: turn it on in System Settings > Privacy & Security > Screen Recording, then say it again.
This is needed once and covers every session, whichever terminal or app Claude runs in.

## Use

| Say | What happens |
|---|---|
| "look at my screen", "what's this error?", "see this?" | Claude takes a screenshot itself. Nothing appears on screen |
| "activate screen buddy" or `/buddy` | This session's buddy appears in the bottom-right corner and listens |
| "where is the export button?" | The buddy flies to it and labels it |
| "follow along" or `/buddy follow` | The buddy watches as you click through something |
| "screen buddy off" or `/buddy off` | The buddy leaves |

While a buddy is active, press **Option+Shift+Space** (or click the buddy) to type to it, Enter to send, Esc to cancel,
Tab to switch between buddies of different sessions. While Claude works, the buddy waits in its corner showing
"Thinking…" or "Looking at your screen…".

## Privacy

- Nothing is captured until Claude calls the `screenshot` or `zoom` tool (or `next_event` while a buddy is listening),
  which shows up as a tool call in your session. You can deny tool calls like any other.
- Screenshots go to Claude the same way an image you pasted would. They are not saved to disk.
- Everything visible on the captured display is included: other windows, notifications. The buddies themselves are
  left out of screenshots.
- With follow-along on, the hub compares small, low-resolution frames of your screen locally to notice changes; only
  the screenshots Claude asks for are sent.
- The hub listens only on a Unix socket that only your user account can open.

## How it works

```
Claude session ──stdio──> adapter ─┐
Claude session ──stdio──> adapter ─┼──Unix socket──> hub (one per Mac, Electron): overlay, hotkey, capture
Claude session ──stdio──> adapter ─┘
```

- **Adapter** (`src/adapter/`, bundled to `dist/server.js`): the MCP server Claude Code starts for each session. It costs
  about 1,500 tokens of tool descriptions and an idle process; it does nothing until a tool is called. It finds the hub
  or starts it, and relays tool calls. When the session ends, its buddy leaves.
- **Hub** (`src/hub/`, `overlay/`): one per machine. Draws the buddies (one transparent, click-through window per display),
  owns the hotkey, captures the screen, tracks scene changes and calibrates. Quits once no buddy is on screen and
  nothing has looked for two minutes.
- **Scene cache:** asking again for an unchanged screen returns a short note instead of a new image; if only part
  changed, only that part is sent. A buddy that is pointing at something goes back to its corner when the screen
  changes there (scrolling, a new page, switching apps or Spaces) and returns if that screen comes back.

## Tools

| Tool | |
|---|---|
| `screenshot(display?, maxDim?, fresh?)` | See the display under the mouse (or display N). No buddy needed |
| `zoom(x, y, width, height)` | Sharp look at a region of the last screenshot, for small text or small targets. No buddy needed |
| `activate(name?)` / `deactivate` | Put this session's buddy on screen / remove it |
| `point_at(x, y, label?)` | Fly the buddy there; its centre lands on the point |
| `highlight(x, y, width, height, label?)` | Glowing box in the buddy's colour |
| `say(text, seconds?)` | Speech bubble |
| `next_event(timeoutSeconds?)` | Wait for your message (or, with follow on, a screen change), with the screen attached |
| `follow(on)` | Report screen changes as you click around |
| `clear`, `get_cursor_position`, `calibrate` | Reset; mouse position; check that screenshot pixels map exactly onto the screen |

## Troubleshooting

- **"Screen Recording permission is missing"**: enable Electron in System Settings > Privacy & Security > Screen
  Recording. If it is already on, turn it off and on again; macOS sometimes needs the app restarted, so say
  "screen buddy off", wait a few seconds, and try again.
- **The hotkey does nothing**: another app may own Option+Shift+Space. Clicking a buddy works too.
- **Something else**: the hub log is `~/Library/Application Support/screen-buddy/hub.log`.

## Uninstall

```
/plugin uninstall screen-buddy@screen-buddy
```

Then delete `~/Library/Application Support/screen-buddy` and remove Electron from the Screen Recording list.

## Develop

```
git clone https://github.com/ChittebbayiPenugonda/ScreenWatchingHarness.git
cd ScreenWatchingHarness
npm install
npm run build      # typecheck, then bundle into dist/ (dist is committed so installs need no build step)
npm run test:look  # looking without a buddy; puts nothing on screen
npm test           # two fake sessions against a real hub; puts buddies on your screen
claude --plugin-dir .   # try your working copy in a session without installing it
```

- `test/calibration.html`: open full screen at 100% zoom. Targets show their centres in screen points, and scenes
  change as you click, to check where buddies land and that they keep up.
- `test/driver.mjs <dir>`: drive buddies by hand by dropping tool calls into `<dir>/cmd.json`. With
  `SCREEN_BUDDY_SHOW_IN_CAPTURE=1` set before the hub starts, buddies show up in screenshots (for checking where they land).

## Limits

- macOS only.
- Screen changes are noticed within about half a second; Space switches instantly.
- Pointing is as accurate as Claude's reading of the screenshot; for small targets it zooms first.

## License

[MIT](LICENSE)
