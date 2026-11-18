# Screen Buddy

A Claude Code plugin (macOS) that gives every Claude session its own small glowing buddy on your screen.
A buddy can see your screen, point at things, draw boxes, talk in a speech bubble, listen when you type to it,
and follow along as you click through an app. Several sessions can have buddies at once, each in its own colour and shape.

## Install

As a plugin from this repo (it is its own marketplace):

```
/plugin marketplace add <this repo's GitHub URL or local path>
/plugin install screen-buddy@screen-buddy
```

The first time a buddy is summoned on a machine without Electron, the plugin installs Electron (~100 MB) into
`~/Library/Application Support/screen-buddy/runtime`. macOS then asks for **Screen Recording** permission for
**Electron**; grant it once in System Settings > Privacy & Security > Screen Recording. It applies to every session,
whatever terminal or app Claude runs in.

## Use

- `/buddy` summons this session's buddy and listens. `/buddy follow` also follows along as you click. `/buddy off` dismisses it.
- Or just ask: "show me where the export button is", "watch me while I fill this in".
- No buddy needed to look: "look at my screen" / "what's this error?" makes Claude take a screenshot itself instead of
  asking you to upload one. Nothing appears on screen.
- Talk to a buddy: press **Option+Shift+Space** (or click a buddy), type, Enter. Tab switches between buddies.

## How it works

```
Claude session ──stdio──> adapter (dist/server.js, one per session)
Claude session ──stdio──> adapter                                     ──Unix socket──> hub (one per machine, Electron)
Claude session ──stdio──> adapter                                                       overlay window per display
```

- **Adapter** (`src/adapter/`): what Claude Code starts for each session. Lists the tools, finds the hub or starts it,
  registers this session's buddy (named after the project folder), relays tool calls. When the session ends, the
  socket closes and the buddy leaves.
- **Hub** (`src/hub/`, `overlay/`): owns the overlay windows, all buddies and their animations, the hotkey, screen
  capture, calibration and change detection. Started by the first adapter that needs it (through LaunchServices, so
  Screen Recording is granted to it directly); quits 30 s after the last buddy leaves. Buddies are excluded from
  screenshots so agents see your screen, not themselves.
- Socket: `~/Library/Application Support/screen-buddy/hub.sock` (owner-only). Log: `hub.log` in the same folder.

## Tools

| Tool | |
|---|---|
| `activate(name?)` / `deactivate` | Put this session's buddy on screen / remove it |
| `screenshot(display?, maxDim?, fresh?)` | See the display under the mouse (or display N), no buddy needed. Cached: "no change" notes and changed-region crops instead of repeat images |
| `zoom(x, y, width, height)` | Full-resolution look at a region (small text, small targets), no buddy needed |
| `point_at(x, y, label?)` | Fly the buddy there; its centre lands on the point |
| `highlight(x, y, width, height, label?)` | Glowing box in the buddy's colour |
| `say(text, seconds?)` | Speech bubble, typed out |
| `next_event(timeoutSeconds?)` | Wait for your message, or (with follow on) a screen change with a fresh screenshot |
| `follow(on)` | Report screen changes as you click around |
| `clear`, `get_cursor_position`, `calibrate` | Reset; mouse position; check the pixel-to-screen mapping |

## Develop

```
npm install
npm run build      # typecheck + bundle into dist/ (dist is committed so the installed plugin needs no build)
npm test           # two fake sessions against a real hub; puts buddies on your screen
npm run test:look  # looking without a buddy; puts nothing on screen
```

- `test/calibration.html`: open full screen at 100% zoom. Targets show their centres in screen points; scenes change as you click.
- `test/driver.mjs <dir>`: drive buddies by hand by dropping tool calls into `<dir>/cmd.json`.
  With `SCREEN_BUDDY_SHOW_IN_CAPTURE=1` set before the hub starts, buddies appear in screenshots (for checking where they land).
- Try the plugin in a session without installing: `claude --plugin-dir .`

## Limits

macOS only. Change detection polls small thumbnails twice a second, so it reports a change about a second after it settles.
