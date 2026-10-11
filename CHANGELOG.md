# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.5.0] - 2026-10-12

### Fixed

- No more "Error: This operation was aborted" after `auto_compact`. The tool no longer compacts mid-run (`ctx.compact()` aborts the active run): it schedules the compaction, which starts on `agent_settled`, once the agent's turn has ended cleanly.

### Changed

- The `auto_compact` tool returns `scheduled` instead of `started`; a second request while one is scheduled returns `busy`.
- Tool description and prompt guidelines: close the turn with a short message instead of "call it last because it aborts the turn".

## [0.4.0] - 2026-10-12

### Changed

- `/auto-compact` with no arguments no longer compacts with a fixed template: the agent writes the prompt to continue the most recent work.
- Removed the built-in default instructions. The compaction prompt is always the agent's (or the requesting extension's); without one, pi's native summary prompt is used.
- The `auto_compact` tool requires `instructions`, and instructions no longer imply `force` for the tool, so the model cannot bypass the threshold just by describing what to keep.
- Late compaction failures (e.g. "Nothing to compact") are shown to the user, not only emitted on `auto-compact:result`.

### Added

- Tool `promptSnippet` and `promptGuidelines`, so the model knows when to compact on its own without a separate skill.
- Tests for the command, the tool and the event API.
- `LICENSE`, `CHANGELOG.md`, `pi-package` keyword and package metadata.

## [0.3.0] - 2026-10-12

### Added

- `/auto-compact <focus>`: the agent writes a compaction prompt for the described focus and runs it through the `auto_compact` tool.

## [0.2.0] - 2026-10-12

### Added

- Model-callable `auto_compact` tool.

## [0.1.0] - 2026-10-12

### Added

- First release on GitHub Packages: `/auto-compact` command, `auto-compact:request` / `auto-compact:result` events, threshold and in-flight guards.

[0.5.0]: https://github.com/raffaelenatale/pi-auto-compact/releases/tag/v0.5.0
[0.4.0]: https://github.com/raffaelenatale/pi-auto-compact/releases/tag/v0.4.0
[0.3.0]: https://github.com/raffaelenatale/pi-auto-compact/releases/tag/v0.3.0
[0.2.0]: https://github.com/raffaelenatale/pi-auto-compact/releases/tag/v0.2.0
[0.1.0]: https://github.com/raffaelenatale/pi-auto-compact/releases/tag/v0.1.0
