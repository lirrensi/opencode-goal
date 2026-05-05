# opencode-plugin-goal

Persistent `/goal` workflows for OpenCode.

`opencode-plugin-goal` emulates Codex-style persistent goals in OpenCode. It registers a `/goal` slash command through OpenCode's plugin `config` hook, persists per-session goal state, exposes goal tools to the model, and queues conservative continuation turns while a goal remains active.

## Install

After publishing to npm, add the package to your OpenCode config:

```json
{
  "plugin": ["opencode-plugin-goal"]
}
```

For local development from this repository, use:

```json
{
  "plugin": ["./src/index.ts"]
}
```

Restart OpenCode after changing plugin config.

## Usage

```bash
/goal fix the failing tests and keep working until they pass
/goal --budget 100k migrate auth to JWT and update tests
/goal status
/goal pause
/goal resume
/goal clear
```

## Behavior

- `/goal <objective>` creates or replaces the session goal and starts work.
- `/goal --budget 100k <objective>` creates a goal with an approximate token budget.
- `/goal status` shows the current goal.
- `/goal pause` stops automatic continuation.
- `/goal resume` reactivates a paused or blocked goal.
- `/goal clear` clears the session goal.
- `get_goal` lets the model inspect the goal.
- `update_goal` lets the model mark the goal `completed` or `blocked`.

Goal state is stored under `.opencode/goals/state.json` in the active project directory.

## How it works

- The plugin adds `command.goal` during OpenCode startup, before the command registry is initialized.
- The `command.execute.before` hook rewrites `/goal` invocations into goal-management prompts.
- The `experimental.chat.system.transform` hook injects active-goal instructions into model turns.
- The `experimental.session.compacting` hook preserves active goal context through compaction.
- The `event` hook watches session idle/status and message events to account usage and queue continuation turns.

Continuation is intentionally conservative. If a continuation turn produces no tool calls, the plugin does not keep auto-continuing, which avoids runaway self-chat loops.

## Development

```bash
bun run check
npm pack --dry-run
```

## Manual npm release

```bash
npm login
npm pack --dry-run
npm publish
```

## Limitations

- This is a plugin-level emulation, not native OpenCode runtime support.
- Token accounting is approximate and based on OpenCode message events.
- Management commands still produce a concise assistant acknowledgement turn.
