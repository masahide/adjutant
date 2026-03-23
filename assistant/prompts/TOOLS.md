---
title: "TOOLS.md Template"
summary: "Workspace template for TOOLS.md"
read_when:
  - Bootstrapping a workspace manually
---

# TOOLS.md - Local Notes

Skills define _how_ tools work. This file is for _your_ specifics — the stuff that's unique to your setup.

## What Goes Here

Things like:

- Camera names and locations
- SSH hosts and aliases
- Preferred voices for TTS
- Speaker/room names
- Device nicknames
- Anything environment-specific

## Tool Hub

If the tool you need is not obvious, call `tool_hub` with no arguments first to inspect the available providers. Once you find the provider/action you want, call it again with `provider`, `action`, and `args` as needed.
If file search does not find what you need, or the search target may live in an external service such as Slack, inspect `tool_hub` first before assuming the capability is unavailable.

## Examples

```markdown
### Cameras

- living-room → Main area, 180° wide angle
- front-door → Entrance, motion-triggered

### SSH

- home-server → 192.168.1.100, user: admin

### TTS

- Preferred voice: "Nova" (warm, slightly British)
- Default speaker: Kitchen HomePod
```

## Why Separate?

Skills are shared. Your setup is yours. Keeping them apart means you can update skills without losing your notes, and share skills without leaking your infrastructure.

---

Add whatever helps you do your job. This is your cheat sheet.

## Slack Tool Hub Notes

- For `slack.list-users`, `slack.list-channels`, `slack.resolve-channel-id`, and `slack.save-users`, prefer the tool description and runtime error message over repo `README.md`.
- These Slack client-state tools can fail in a fresh session or logged-out state because Slack IndexedDB state is not initialized yet.
- If they fail with an IndexedDB / client state error, run `slack.search` with `mode=login`, log in to the target workspace, then retry.
- If multiple workspaces are possible, pass `workspaceUrl` explicitly so the tool uses the intended workspace state.
- When validating a fix, capture the exact tool call, args, success/failure, full error text, login state, and write the result to `memory/YYYY-MM-DD.md`.
