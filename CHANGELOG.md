# Changelog

## 0.1.0

- Initial release.
- Register `/goal` via OpenCode plugin config mutation.
- Persist per-session goal state under `.opencode/goals/state.json`.
- Add `get_goal` and `update_goal` model tools.
- Add active-goal system prompt and compaction context preservation.
- Add conservative idle continuation and budget-limited wrap-up behavior.
