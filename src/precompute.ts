import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CompactionEntry, ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";
import { type EstimateTokens, planSpan } from "./span.ts";

// After a compaction, the next one needs at least this much new context (or a quarter of the
// threshold, whichever is larger) on top of the post-compaction size. This is what stops a
// compaction that leaves the context above the threshold from retriggering on every turn.
export const MIN_GROWTH_TOKENS = 10_000;

export const growthFor = (threshold: number) => Math.max(MIN_GROWTH_TOKENS, Math.floor(threshold / 4));

// ---------------------------------------------------------------------------------------------------
// Trigger

/**
 * The context size above which auto-compaction fires: `tokens > compactAt`. Same rule as the loop guard
 * (`tokens > threshold && (baseline === null || tokens - baseline >= growth)`): `tokens - baseline >= growth`
 * is `tokens > baseline + growth - 1` for integer token counts, hence the `- 1`.
 */
export function compactAt(threshold: number, baseline: number | null, growth: number): number {
	return baseline === null ? threshold : Math.max(threshold, baseline + growth - 1);
}

/** How far before `compactAt` a background job starts: half the growth (5k at a 40k threshold, 25k at 200k). */
export const leadFor = (growth: number) => Math.floor(growth / 2);

export type PrecomputeState = "idle" | "running" | "ready" | "paused";

export interface StartInput {
	tokens: number;
	threshold: number;
	baseline: number | null;
	awaitingBaseline: boolean;
	growth: number;
	state: PrecomputeState;
	/** True when the per-cycle job budget is spent. */
	budgetExhausted?: boolean;
}

/** Whether a background job should start now: close to the trigger, but not past it and not while one is busy. */
export function shouldStart({ tokens, threshold, baseline, awaitingBaseline, growth, state, budgetExhausted = false }: StartInput): boolean {
	if (awaitingBaseline || budgetExhausted || state !== "idle") return false;
	const trigger = compactAt(threshold, baseline, growth);
	return tokens > trigger - leadFor(growth) && tokens <= trigger;
}

/**
 * How much to keep verbatim when planning the span ahead of time: at the trigger the kept tail will have grown
 * by `compactAt - tokens`, so plan a smaller one now (never below half of `keepRecent`).
 */
export function aheadKeep(keepRecent: number, tokens: number, trigger: number): number {
	return Math.max(keepRecent - (trigger - tokens), Math.floor(keepRecent / 2));
}

// ---------------------------------------------------------------------------------------------------
// Snapshot

/** A span planned ahead of time, with what is needed to check later that it is still valid. */
export interface Snapshot {
	/** The compaction the span continues from (undefined = none). */
	previousId?: string;
	/** Context entries replaced by the span (those after `previous`, before `firstKeptEntryId`). */
	entryIds: string[];
	/** Fingerprint of those entries' ids and model-visible messages. */
	hash: string;
	firstKeptEntryId: string;
	messages: AgentMessage[];
	previous?: CompactionEntry;
	/** `settingsKey(...)` of the summary settings in force when the job started. */
	settingsKey: string;
	startedAt: number;
}

/** sha256 of the ids and messages of `entries`: changes with any `context_edit` on them. */
export function hashEntries(entries: readonly ProjectedSessionEntry[]): string {
	return createHash("sha256")
		.update(JSON.stringify(entries.map((e) => [e.sourceEntry.id, e.messages])))
		.digest("hex");
}

/** Index of the newest compaction in the projection (it comes first, followed by its retained tail), or -1. */
const compactionIndex = (entries: readonly ProjectedSessionEntry[]) =>
	entries.findIndex((e) => e.sourceEntry.type === "compaction" && e.messages.length > 0);

export interface CreateSnapshotInput {
	/** Tokens to keep verbatim (see `aheadKeep`). */
	keep: number;
	estimate: EstimateTokens;
	settingsKey: string;
	startedAt: number;
}

/** Plan the span with `planSpan` and fingerprint it; undefined when there is nothing to compact. */
export function createSnapshot(entries: readonly ProjectedSessionEntry[], { keep, estimate, settingsKey, startedAt }: CreateSnapshotInput): Snapshot | undefined {
	const span = planSpan(entries, keep, estimate);
	if (!span) return undefined;
	const start = compactionIndex(entries) + 1;
	const cut = entries.findIndex((e, i) => i >= start && e.sourceEntry.id === span.firstKeptEntryId);
	if (cut < 0) return undefined;
	const covered = entries.slice(start, cut);
	return {
		previousId: span.previous?.id,
		entryIds: covered.map((e) => e.sourceEntry.id),
		hash: hashEntries(covered),
		firstKeptEntryId: span.firstKeptEntryId,
		messages: span.messages,
		previous: span.previous,
		settingsKey,
		startedAt,
	};
}

export interface ValidateInput {
	/** `settingsKey(...)` now. */
	settingsKey: string;
	keepRecent: number;
	/** `leadFor(growth)`: how much the kept tail may exceed `keepRecent`. */
	lead: number;
	estimate: EstimateTokens;
}

export type Validation = { ok: true } | { ok: false; reason: string };

/** Whether `snapshot` can still be adopted against the current context. */
export function validateSnapshot(
	snapshot: Snapshot,
	entries: readonly ProjectedSessionEntry[],
	{ settingsKey, keepRecent, lead, estimate }: ValidateInput,
): Validation {
	const prevIndex = compactionIndex(entries);
	const currentPrevious = prevIndex >= 0 ? entries[prevIndex].sourceEntry.id : undefined;
	if (currentPrevious !== snapshot.previousId) return { ok: false, reason: "another compaction happened in between" };

	const after = entries.slice(prevIndex + 1);
	const n = snapshot.entryIds.length;
	if (after.length < n || snapshot.entryIds.some((id, i) => after[i].sourceEntry.id !== id)) {
		return { ok: false, reason: "the branch changed (entry ids differ)" };
	}
	if (hashEntries(after.slice(0, n)) !== snapshot.hash) return { ok: false, reason: "compacted entries were edited" };
	if (after[n]?.sourceEntry.id !== snapshot.firstKeptEntryId) return { ok: false, reason: "the first kept entry is gone" };
	if (snapshot.settingsKey !== settingsKey) return { ok: false, reason: "summary model or thinking settings changed" };

	let tail = 0;
	for (const entry of after.slice(n)) for (const message of entry.messages) tail += estimate(message);
	if (tail > keepRecent + lead) return { ok: false, reason: `the kept tail grew too large (${tail} > ${keepRecent + lead} tokens)` };
	return { ok: true };
}
