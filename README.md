# Screen Watching Harness

An MCP server that lets an agent see your screen and point at things with a click-through overlay.

## Setup
```
npm install
npm run build
claude mcp add screen-watching -- node "$(pwd)/dist/server.js"
```
Grant **Screen Recording** permission to the app that launches the server (Terminal / VS Code / Claude Code) in System Settings > Privacy & Security, then restart it.

## Tools
- `activate` – show the helper (starts the overlay). The helper is **off** until this is called
- `deactivate` – remove the helper (stops the overlay)
- `screenshot` – downscaled JPEG of the main display; defines the pixel space for pointing
- `point_at(x, y, label?)` – glide the pointer to a spot
- `highlight(x, y, width, height, label?)` – draw a box
- `say(text, seconds?)` – show a speech bubble from the helper
- `wait_for_message(timeoutSeconds?)` – wait for the user to type to the helper (Option+Shift+Space); call in a loop
- `clear` – send the helper home, remove bubble and boxes
- `get_cursor_position` – where your mouse is

## How it works
`src/server.ts` (MCP, stdio) <-> WebSocket on 127.0.0.1:47800 <-> `overlay/` (Electron, transparent always-on-top window).
Screenshot-space coordinates are scaled to screen points in the server.

## Next
Accessibility-tree element targeting, change detection, multi-display, region capture.
