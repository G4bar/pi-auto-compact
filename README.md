# pi-auto-compact

An extension for [pi](https://pi.dev) (tested on pi 1.6.0) that compacts the context automatically once it
exceeds a **percentage of the active model's context window** (default **20%**), writes a **checkpoint that
keeps a verbatim record of the conversation**, and **never interrupts the running agent**.

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

### Trigger

- On every completed `turn_end` (when enabled) it reads `ctx.getContextUsage()`.
- If `tokens > threshold` it compacts. `threshold = max(floor(window × percent / 100), minTokens)` (`minTokens`
  is `40 000` by default, e.g. 200k window → 40k at 20%).
- **Loop guard:** the first completed turn after any compaction is skipped to measure the post-compaction
  baseline; the next compaction then needs at least `max(10k, threshold / 4)` tokens of new context on top
  of that baseline, so a compaction that leaves the context above the threshold cannot retrigger on every
  turn. If a compaction fails, it retries only after the context has grown further.
- The 40 000-token floor exists because the fixed prefix (system prompt + tools) is already ~14k tokens and
  pi keeps ~20k recent tokens: on small windows a pure percentage would compact on every turn.

### It does not stop the agent

The old version called `ctx.compact()`, which first aborts the running agent and never resumes it: every
auto-compaction ended the run mid-task. This version appends the compaction as a **session entry at the
turn boundary** (pi's `turn_end` boundary result), so the agent simply carries on with the compacted context
on its next request. No abort, no re-prompt.

Safety net: models sometimes lose the thread right after a compaction and end the turn with a status line
("Read f3.txt.", "Ready for the next file") instead of calling a tool. When a run is about to settle
without any tool-call turn since one of our auto-compactions (including if the compaction ran on that
text-only turn), the extension asks for **one** continuation (`agent_before_settle`). The trigger is
structural, not a guess about the wording: stall replies seen in testing included a bare "Read f3.txt."
and a sentence in Chinese. The price is that a genuine final answer written right after a compaction is
nudged too; the message asks the agent to repeat it unchanged, so that costs one extra turn. Questions and
invitations ("let me know") to the user, aborted or failed runs, and sessions with `/autocompact off` are
never nudged. Turn it off permanently with `"resume": false`.

### Checkpoint

Instead of one free-form summary, the checkpoint (following the design of
[transparent-compact](https://arxiv.org/abs/2610.20116), plus a model-written state for what the record
cannot hold) has parts with different guarantees:

| Part | Source | Guarantee |
|---|---|---|
| **Record** | computed by code, no model: user messages `[U1 · time]` and assistant prose `[A]` verbatim (reasoning excluded; non-text user blocks noted as `[image]`, etc.), each tool call as a one-line signature `→ read path="a.ts"` (`✗` = the call failed), all in order | Prose is never reworded. A message over 4k chars keeps head and tail with an inline `[… N chars omitted …]`; long tool signatures are clipped. |
| **State summary** | model, iterative: updates the previous state instead of re-summarizing a summary | Covers what the record lacks: facts from tool output. Exact values quoted, VERIFIED separated from ASSUMED, truncated output never extrapolated (capped at 30k chars, newest kept). |
| **File lists** | computed from successful `read`, `edit`, and `write` tool calls (up to 200 each) | `<read-files>`, `<modified-files>` (modified overrides read), flagged as not in context. |
| **Recovery pointer** | the `session_recall` tool, else the session file path | With the [recall tool](#recall-tool) active (default), the checkpoint and the dropped-text stubs tell the agent to use it. Without it, the raw transcript stays on disk and the checkpoint tells the agent how to search it (or notes that the session is not persisted). |

The record is carried forward across compactions, so after several of them it still holds the whole
conversation, within a budget of a quarter of the compaction threshold (4k–40k tokens). Past it, content is
dropped oldest first in order of value: tool signatures, then assistant prose, then user messages. Dropped
prose and user messages leave a stub with their original size (while consecutive dropped tool calls collapse
into a count; the text is still in the transcript), and the newest user and assistant messages always keep
their text.

The checkpoint states what was removed (tool outputs, reasoning) and tells the agent to resume rather than
restart. If the summarization call fails it retries once (falling back to the active model if a different
summary model was configured); if the second attempt also fails, it degrades to the record plus the previous
state (without updates), so the compaction still succeeds. Manual `/compact` and pi's own
threshold/overflow compaction use the same checkpoint (via `session_before_compact`); if aborted or
building fails unexpectedly, pi falls back to its default summary.

What is kept verbatim after the checkpoint follows pi's own rule: about `compaction.keepRecentTokens` of the
newest messages (read from your `settings.json`, including project and per-model overrides), never cutting
between a tool call and its result.

### Recall tool

A read-only tool, `session_recall`, lets the agent look up what compaction removed instead of grepping the
session file (inspired by pi-context-kit's `recall`, under a different name so both can coexist). It reads the
session through pi (`ctx.sessionManager`), so it also works for sessions that are not persisted.

| Call | Effect |
|---|---|
| `query` | literal, case-insensitive search over the current branch, newest first, with the entry id and a snippet (±150 chars). `scope`: `"compacted"` (default: only entries no longer in the context) or `"all"` (entries still in context are marked). `limit`: default 10, max 50. |
| `entryId` | the full text of one entry: a user message, assistant prose with one line per tool call, or a tool result headed by the call that produced it (name and arguments). Paged with `offset` and `maxChars` (default 12,000, max 40,000); the footer says which `offset` continues. |

A tool result also matches on its call's signature, so `path="a.ts"` finds what was read from `a.ts`. Reasoning
is not recallable, images appear as `[image]`, and output is always capped (at pi's 50 KB limit as a last
resort). The tool is always active, independent of `/autocompact off`, and costs a short tool description in
every request; set `"recall": false` in `auto-compact.json` to not register it (the checkpoint then keeps the
session-file wording).

### Precompute (background summary)

Opt-in (`"precompute": true` or `/autocompact precompute on`; off by default). Without it nothing below changes:
the checkpoint is built at the trigger and the agent waits for the summary model (up to ~90 s with high thinking).
With it, the model-written **state summary is prepared in the background while the agent works** (the idea comes
from pi-precompact (patlux)), so the compaction at the trigger usually does not
wait for the model at all.

- **When it starts.** On a `turn_end` where the context is within a *lead* of the trigger: `tokens > compactAt − lead`
  (and not yet above `compactAt`). `compactAt` is the loop-guard limit (`threshold` for the first compaction of a
  cycle, then `max(threshold, baseline + growth − 1)`), `growth = max(10k, threshold / 4)` and `lead = growth / 2`
  (5k at a 40k threshold, 25k at 200k). Never while the baseline after a compaction is still being measured.
  One job at a time, at most 2 per compaction cycle, a 180 s deadline, and a pause after 2 failures (lifted by the
  next compaction or `/autocompact precompute on`).
- **What it plans.** A *snapshot*: the span to replace, planned with pi's cut rule, plus a fingerprint (sha256 of the
  ids and messages it covers). Since the context keeps growing until the trigger, the cut is made early with a
  smaller verbatim tail, `max(keepRecent − (compactAt − tokens), keepRecent / 2)`, so that the tail at the trigger
  is about `keepRecent`. Messages added after the snapshot simply stay verbatim; there is no catch-up model call.
- **At the trigger.** A ready snapshot is adopted: no model call, its `firstKeptEntryId` and the record of its
  messages go into the compaction entry, and a notification says `prepared in Xs · no wait`. A job still running is
  awaited (`waited Ys`): it started earlier, so waiting never costs more than a new call. A failed, expired or
  invalid snapshot falls back to the synchronous path above.
- **Validation**, before adoption and again after any wait: same previous compaction, the covered entries are an
  exact prefix of the current ones with the same hash (a `context_edit` or a branch change fails it), the first kept
  entry still exists, the summary settings (summary model, resolved thinking level, active model) are unchanged,
  the kept tail is not larger than `keepRecent + lead`, and the state is not the degraded fallback.
- **What discards it.** A compaction of any kind (`session_compact`), `/tree` navigation, a model change, a session
  thinking change (only with `/autocompact think session`), session shutdown or reload (the model call is aborted),
  `/autocompact off`, `model`, `think`, a new percentage or `precompute off`, and pi's own compaction
  (`session_before_compact`). Manual `/compact` (with focus), context-overflow recovery and pi's threshold
  compaction never use a snapshot: they compute the checkpoint fresh, as before.
- **Cost.** A discarded job was paid for without benefit. Its usage is recorded as a `custom` session entry,
  `auto-compact-discarded` (`{ reason, model, usage }`), at the next turn boundary; pi does not count it in its
  cost totals. Hence the opt-in default: turn it on once you know your summary model is cheap or you are tired of
  waiting. `/autocompact status` shows `precompute on (state; last dropped: reason)`.
- **Other extensions.** It is not compatible with extensions that also replace or precompute the compaction
  (pi-precompact in particular): only one of them should own `session_before_compact`. Do not enable both.

The background call runs in parallel with the agent's own requests, so it can contribute to provider rate limits.

## Commands

| Command | Effect |
|---|---|
| `/autocompact` / `/autocompact status` | show state, percentage, current threshold, summary model, thinking level, and whether recall and precompute are on |
| `/autocompact 15` | set the percentage (`0 < N < 100`) and enable |
| `/autocompact on` / `off` | enable / disable for the current session (`off` also disables the resume nudge) |
| `/autocompact model` | menu to choose the model that writes the summaries, then a menu for its thinking level (skipped if the model has none) |
| `/autocompact model provider/id` | set it directly (`default` / `active` / `reset` = the active model) |
| `/autocompact think` | menu to choose the thinking level of the summary model |
| `/autocompact think <level>` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `session` (same as the session) or `default` (= off) |
| `/autocompact precompute [on\|off]` | enable / disable the [background summary](#precompute-background-summary) (without an argument: show it); `on` also lifts a pause after failures |

`/autocompact N`, `/autocompact model`, `/autocompact think` and `/autocompact precompute` save to `~/.pi/agent/auto-compact.json` (or
`$PI_CODING_AGENT_DIR/auto-compact.json`), so they become the default for all future sessions. `on` / `off`
last for the current session only.

**Summary model.** By default the active model writes the state summary. Pick a cheaper one (e.g. a Haiku)
with `/autocompact model`: the record is computed by code, so only the state summary depends on the model.
If the chosen model is unavailable, fails, or its window is too small for the span, the active model is used
and a warning says so.

**Summary thinking.** Off by default. The menu offers `Off (default)`, `Same as the session`, and the levels
the summary model supports (skipped if the model has no thinking levels). A level it does not support is
moved to the nearest supported one (higher first, then lower, as pi does). Thinking tokens are billed as
output and add latency, and the summary is mostly transcription, so more is not obviously better.
One measurement, Haiku 5.5 as summary model on three ~40k-token spans: `low` used 0 reasoning tokens (the
model chose not to think), `max` used 22k–24k reasoning tokens for a ~1.5k-token summary and took about 90 s
per compaction. Whether it improves the summary was not measured.

## Configuration

Optional `~/.pi/agent/auto-compact.json` (or `$PI_CODING_AGENT_DIR/auto-compact.json`). Defaults (invalid
values fall back to these):

```json
{ "percent": 20, "minTokens": 40000, "resume": true, "recall": true, "precompute": false, "thinking": "off" }
```

You can also add `"model": "provider/id"` (e.g. `"anthropic/claude-haiku-5-5"`) to use a dedicated summary
model by default; omitting it uses the active model. `precompute` is opt-in: only an explicit `true` enables it.
`minTokens`, `resume` and `recall` are configured in this file only and preserved when `/autocompact` commands
update `percent`, `model`, `thinking` or `precompute`.

## Interaction with built-in compaction

The built-in threshold (`contextWindow - reserveTokens`, where `reserveTokens` defaults to 16 384) stays
active as a safety net; this extension nearly always fires first. You do not need to change `compaction` in
`settings.json`.

## Caveats

- Each compaction costs one summarization request (active model, or the one set with `/autocompact model`)
  and invalidates the prompt cache, so the next turn pays a cache write. Too low a percentage can cost more than it saves.
- With `precompute` on, a snapshot that is discarded (branch edited, model changed, session closed...) means a
  summarization request that bought nothing; it is logged in an `auto-compact-discarded` entry. A job that is
  still running when the session ends is aborted, but its usage may be lost.
- Precompute is tested with a faked pi and end to end with the pi SDK and a faux provider (the faux model
  answers with a configurable delay); measuring the wait it saves with a real provider in a real
  session is still to be done by hand (`/autocompact precompute on`, then a notification should say `no wait`).
- Compaction is still lossy: tool outputs survive only through the state summary and what `session_recall`
  (or the raw transcript on disk) can bring back, and the record is bounded (long messages are shortened, old content is dropped past the budget).
  The checkpoint says so, and the summarizer is told not to extrapolate from truncated tool output.
- The retention quality of this design has not been benchmarked here; the guarantees above describe what is
  kept, not measured recall.
- The resume safety net cannot fix a model that stalls for reasons unrelated to compaction (e.g. ending a
  turn with "Next: X" in the middle of a run, with no compaction involved).

## Development

```bash
npm install
npm run check   # tsc --noEmit
npm test        # node --test
```

## License

MIT
