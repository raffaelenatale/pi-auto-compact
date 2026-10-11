# pi-auto-compact

[![CI](https://github.com/raffaelenatale/pi-auto-compact/actions/workflows/ci.yml/badge.svg)](https://github.com/raffaelenatale/pi-auto-compact/actions/workflows/ci.yml)
[![Publish](https://github.com/raffaelenatale/pi-auto-compact/actions/workflows/publish.yml/badge.svg)](https://github.com/raffaelenatale/pi-auto-compact/actions/workflows/publish.yml)

Context compaction for [pi](https://github.com/earendil-works/pi) at **logical checkpoints**, with the compaction prompt written by the agent instead of a fixed template.

## Why

pi compacts automatically when the context is close to full, and `/compact` summarizes on demand. Long sessions have better moments to compact: a task is closed, a phase is finished, the work is about to change focus. Compacting there works better — but only if the summary keeps what the *next* work needs. What that is, the agent knows better than any fixed template, so this extension always delegates the prompt to the agent's judgment and never merges in canned instructions.

## What you get

| Entry point | What it does |
| --- | --- |
| `/auto-compact [focus]` | Sends a request to the agent: write a compaction prompt for this focus (default: *continue working on the most recent work*) and run it through the `auto_compact` tool. |
| `/auto-compact status` | Shows whether the extension is enabled, the threshold and the current context usage. |
| `auto_compact` tool | The model compacts on its own at a checkpoint — no user command needed. `instructions` (the prompt it wrote) is required; the compaction runs right after the turn ends. |
| `auto-compact:request` event | Other extensions request a compaction: `{ reason?, instructions?, force? }`. Without `instructions`, pi's native summary prompt is used. |
| `auto-compact:result` event | Outcomes: `compacted \| skipped \| busy \| error`, with `reason` and `detail`. |
| `globalThis.__pi_auto_compact_request(payload, ctx)` | Same request, for code that cannot reach the event bus. |

Compaction runs through pi's native `ctx.compact({ customInstructions })`. That call aborts any active agent run, so the `auto_compact` tool never compacts mid-run: it **schedules** the compaction, the agent closes its turn with a short message, and the compaction starts on `agent_settled`, when the agent is idle — like the native `/compact`, with no "operation was aborted" error. The tool's prompt guidelines tell the model this, without any skill.

## Guards

- **Threshold**: unforced requests are skipped below the context-usage threshold (`PI_AUTO_COMPACT_THRESHOLD`, default `60`%). A forced request or one with explicit `instructions` coming from the event API bypasses it; the `auto_compact` tool bypasses it only with `force: true`, so the model cannot over-compact on its own.
- **In flight**: while a compaction is scheduled or running, further requests return `busy` without retry.
- **Disable**: `PI_AUTO_COMPACT=0` (or `false`) skips every request.
- **No context**: outside a real pi session the request returns `error` instead of pretending success.

## Install

Published on GitHub Packages. You need a `~/.npmrc` that maps the scope to the GitHub registry with a token that has `read:packages` (any token works for packages of public repos; for private ones, the token's account must have access):

```ini
@raffaelenatale:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=<token>
```

Then:

```sh
pi install npm:@raffaelenatale/pi-auto-compact
```

After a release you can update with the same command (or `pi update`, if you installed without pinning a version). Reload pi (or restart the session) to load a newly installed version.

## Integration example

Another extension can compact at its own logical boundaries:

```ts
pi.events.emit("auto-compact:request", {
  reason: "phase 2 closed",
  instructions: "Keep the run contract and the phase findings table", // optional
  force: false,
});

pi.events.on("auto-compact:result", (r) => console.log(r.status, r.reason, r.detail));
```

## Development

```sh
git clone https://github.com/raffaelenatale/pi-auto-compact.git
cd pi-auto-compact
npm test          # node:test, no dependencies
```

- `src/index.ts` — the extension (single file, no runtime dependencies; `@earendil-works/pi-coding-agent` is host-provided and declared as a peer).
- `test/` — unit tests for the decision logic and the command/tool/event surfaces with a fake pi.
- CI runs the tests on Node 22 and 24; publishing to GitHub Packages happens on each [release](CHANGELOG.md), with a tag/version check.

Releasing: update `CHANGELOG.md`, bump `version` in `package.json`, push, then create a release tagged `v<version>` — the Publish workflow tests and publishes.

## License

[MIT](LICENSE)
