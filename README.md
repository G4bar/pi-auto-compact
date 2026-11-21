# pi-auto-compact

A tiny extension for [pi](https://pi.dev) (tested on pi 1.6.0) that compacts the context automatically
once it exceeds a **percentage of the active model's context window** (default **20%**).

pi's built-in auto-compaction only supports an absolute `reserveTokens`, so a percentage threshold that
works for every model would need one override per model. This extension computes the threshold from the
window of whichever model is active, so it keeps working when you switch models.

## Why

Every turn re-sends the whole context. With prompt caching, long contexts are cheap per token, but cache
writes and cache reads still grow with the context size. Compacting early keeps sessions small and cheap.

## Install

```bash
pi install git:github.com/G4bar/pi-auto-compact   # or: pi install /path/to/pi-auto-compact
```

No configuration is required. Try it once without installing: `pi -e ./src/index.ts`.

## How it works

- On every `turn_end` it reads `ctx.getContextUsage()`.
- If `tokens > threshold`, it calls `ctx.compact()` and shows a notification.
- `threshold = max(window × percent, 40 000)`. Example: 1M window → 100k tokens at 10%.
- **Loop guard:** after triggering, it re-arms only once usage falls back under the threshold, so a
  compaction that leaves the context above the threshold cannot retrigger on every turn. If a compaction
  fails, it retries on the next turn.

### The 40 000-token floor

The fixed prefix (system prompt + tool definitions) is already ~14k tokens, and pi keeps the most recent
20k tokens after a compaction. On small windows a pure 10% (e.g. 12.8k for a 128k window) would sit below
that and compact on every turn. The floor only changes behavior for models with a window under 400k.

## Commands

| Command | Effect |
|---|---|
| `/autocompact status` | show state, percentage and the current threshold |
| `/autocompact 15` | set the percentage (1–99) and enable |
| `/autocompact on` / `off` | enable / disable |

`/autocompact N` saves the percentage to `~/.pi/agent/auto-compact.json` (`{ "percent": N }`), so it becomes
the default for all future sessions. `on` / `off` last for the current session only. Without the file the
built-in default (`DEFAULT_PERCENT` in `src/index.ts`, 20) applies; `MIN_THRESHOLD_TOKENS` is also in that file.

## Interaction with built-in compaction

The built-in threshold (`contextWindow - reserveTokens`, 16 384 by default) stays active as a safety net;
at 10% this extension nearly always fires first. You do not need to change `compaction` in `settings.json`.

## Caveats

- Each compaction costs one summarization request and invalidates the prompt cache, so the next turn pays a
  cache write. Too low a percentage can cost more than it saves; if compactions feel too frequent, raise it
  (`/autocompact 20`).
- Compaction is lossy: details from old turns survive only through the summary.

## License

MIT
