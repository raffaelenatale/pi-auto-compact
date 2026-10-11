# pi-auto-compact

Automatic context compaction for [pi](https://github.com/earendil-works/pi) at **logical checkpoints** — not only when the context overflows. Born from Convoy's need to compact Alpha's context between phases; usable by any long session with milestone boundaries.

## Install

Pubblicato su GitHub Packages (`@raffaelenatale/pi-auto-compact`). Serve un `~/.npmrc` che mappa lo scope sul registry GitHub con un token con scope `read:packages`:

```ini
@raffaelenatale:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=<token con read:packages>
```

```sh
pi install npm:@raffaelenatale/pi-auto-compact
```

## Usage

- `/auto-compact <focus>` — describe what the next work is about (e.g. `/auto-compact lavoriamo sulla task 3, fix bug visualizzazione dati`). The agent writes a compaction prompt for that focus and runs it through the `auto_compact` tool. The compaction is forced.
- `/auto-compact` (no args) — compact now with the default instructions.
- `/auto-compact status` — show enabled/threshold/current usage/instructions template.

The model can also compact by itself through the `auto_compact` tool (`reason?`, `instructions?`, `force?`), with the same rules as `/auto-compact`: without instructions it is skipped below the threshold.

Other extensions request a compaction at a logical point by emitting the custom pi event:

```ts
pi.events.emit("auto-compact:request", {
  reason: "phase-2 closed",
  instructions: "Keep the run contract and the phase findings table",
  force: false,
});
```

Results come back on `auto-compact:result` (`compacted | skipped | busy | error`, with `detail`). Tool code can also call `globalThis.__pi_auto_compact_request(payload, ctx)`.

## Configuration

| Env | Default | Meaning |
| --- | --- | --- |
| `PI_AUTO_COMPACT` | `1` | `0`/`false` disables requests |
| `PI_AUTO_COMPACT_THRESHOLD` | `60` | minimum context usage (%) for unforced requests |

Unforced requests (no explicit instructions, no `force`) are skipped below the threshold — a fresh session does not get compacted at every checkpoint. A compaction already in flight answers `busy` without retrying.

The default instructions preserve: contract/plan and frozen decisions; run/checkpoint state and next steps; open human questions and answers; evidence paths and head commits.

## Convoy integration

The `convoy-pi` extension emits `auto-compact:request` when a bound run's phase changes (green + discussed), with instructions to keep contract, state and decisions. This extension is optional: without it Convoy simply does not compact at phase boundaries.

## License

MIT
