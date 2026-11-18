---
name: screen-buddy
description: Screen Buddy. Use when the user asks you to look at their screen ("look at my screen", "see this?", "what's this error") instead of uploading a screenshot, says "activate screen buddy" (or "screen buddy on/off"), wants you to show them where something is on their screen, follow along while they click through an app, or talk to you through the buddy.
---

# Screen Buddy

## Looking at the screen (no buddy needed)

When the user wants you to see something on their screen, call `screenshot` yourself; never ask them to upload one. It captures the display under their mouse (pass `display` for another one). Use `zoom` on a region to read small text. This works whether or not the buddy is active, and nothing appears on their screen.

## The buddy

This session has its own buddy: a small glowing shape on the user's screen, in its own colour, named after this project (or the name you chose). Other sessions may have buddies too.

## Turn it on and listen

1. `activate` (optionally with a short `name`). The first call on a machine takes a few seconds while the overlay starts.
2. `say` a one-line hello, mentioning they can press Option+Shift+Space or click you to type.
3. Loop on `next_event`. Every event comes with the current screen attached, so act on it directly:
   - "The user says: …" → answer through the buddy. If they ask where something is, `point_at` it straight from the attached screen, with the answer as the label. That one call both shows and tells; skip a separate `say`.
   - "The screen changed" (only with follow on) → only speak or point if it helps with what the user is doing; otherwise go straight back to `next_event`.
   - "Nothing yet" → call `next_event` again.
4. "screen buddy off", "go away", "stop" → `deactivate`.

While looping, keep chat replies to a minimum; the conversation is happening through the buddy.

## Be quick

The user is watching the buddy sit in its corner saying "Thinking…" while you work, so every extra call is time they wait.
- Don't call `screenshot` if the event already gave you the screen.
- Point from the 1280 px screenshot for anything bigger than about 20 px in it. Use `zoom` only for tiny targets (small icons, checkboxes, links).
- Labels and `say` text: one short sentence.

## What screenshots return (scene cache)

- A new image: "Screenshot #n". Its pixels are the coordinate space.
- "No change since your screenshot #n": no image. Keep using #n and its coordinates (it may be an earlier screenshot the user has returned to).
- "Only part of #n changed": a crop of the changed part at the same scale, with its offset. Add the offset to positions in the crop to get #n coordinates.
- `screenshot` with `fresh: true` always sends a whole new image.

## Pointing

- Coordinates are always in the pixels of the current screenshot (or the last `zoom`).
- The buddy's centre lands exactly on the point; aim at the middle of the target.
- The buddy watches its target. If the screen moves on (scroll, new page, app or Space switch), it tucks itself back into its dock, and returns if that screen comes back. You don't need to clean up after the user moves on.
- If `point_at` warns that the spot changed since your screenshot, look again before pointing.
- If pointing seems off, run `calibrate` and tell the user the result.

## Following along

`follow(true)` when the user wants you to keep up as they click through something ("watch me", "follow along", "walk me through this"). `follow(false)` when that is done.
