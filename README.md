# opencode-plugin-goal — DEPRECATED

> **⚠️ This fork is abandoned.** Do not use this. It is broken in fundamental ways — ESC-to-cancel requires 4 presses, goals continue after completion, and the system prompt gets polluted on every turn.
>
> **Use [mirsella/opencode-goal](https://github.com/mirsella/opencode-goal) instead.** It is available as `opencode-goal` on npm and is the canonical, actively maintained implementation.

## What happened

This was a personal fork of [watzon/opencode-goal](https://github.com/watzon/opencode-goal) with stability fixes. It was a stepping stone — not a destination.

[mirsella/opencode-goal](https://github.com/mirsella/opencode-goal) is the mature successor. It fixes everything this fork couldn't:

- One ESC press to cancel (auto-pauses on interrupt)
- No continuation after goal completion (in-memory state, no race conditions)
- No system prompt pollution (uses message transforms instead)
- Stagnant recovery mode (no more infinite stop-without-action loops)
- `/goal append <text>` support
- Proper test suite
- Semantic continuation prompts with completion audit instructions
- Published on npm as `opencode-goal`

## Install the real thing

```json
{
  "plugin": ["opencode-goal"]
}
```

Restart OpenCode and it auto-installs.

## Historical note

The fixes from this fork (state recovery, compaction safety, continuation cleanup) were all upstream learnings that informed Mirsella's implementation. Consider this a fossil. 🦴
