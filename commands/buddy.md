---
description: Activate Screen Buddy for this session and listen through it ("/buddy off" turns it off)
argument-hint: "[off | follow | name]"
---

Use the screen-buddy skill.

Arguments: "$ARGUMENTS"

- If the arguments are "off", "bye" or "stop": call `deactivate` and confirm in one line.
- Otherwise call `activate` (if the arguments are a short word other than "follow", use it as the buddy's name), `say` a one-line hello, and if the arguments include "follow", call `follow` with on = true. Then keep calling `next_event` and respond through the buddy until the user asks you to stop.
