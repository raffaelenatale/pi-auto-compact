# pi-auto-compact

Automatic context compaction for [pi](https://github.com/earendil-works/pi) at **logical checkpoints** — not only when the context overflows. Born from Convoy's need to compact Alpha's context between phases; usable by any long session with milestone boundaries.

## Install

```sh
pi install npm:pi-auto-compact   # or: pi install /path/to/pi-auto-compact
```

## Usage

- `/auto-compact [instructions]` — compact now (explicit instructions force the compaction regardless of usage).
- `/auto-compact status` — show enabled/threshold/current usage/instructions template.

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
