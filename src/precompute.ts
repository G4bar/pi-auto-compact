import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { CompactionEntry, ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";
import { type EstimateTokens, planSpan } from "./span.ts";
import type { Generated } from "./summarize.ts";

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

// ---------------------------------------------------------------------------------------------------
// Background job

export interface Taken {
	snapshot: Snapshot;
	generated: Generated;
	/** How long `take` waited for a running job (0 when it was ready). */
	waitedMs: number;
	/** How long the job took to produce the state. */
	preparedMs: number;
}

/** Usage of a job whose result was never adopted, to be recorded as an `auto-compact-discarded` entry. */
export interface Discarded {
	usage: Usage;
	reason: string;
	model?: string;
}

export interface PrecomputerOptions {
	/** Writes the state for a snapshot. Must honor `signal`; may reject. */
	run: (snapshot: Snapshot, signal: AbortSignal) => Promise<Generated>;
	now: () => number;
	deadlineMs?: number;
	maxJobsPerCycle?: number;
	/** Consecutive failures that pause the precompute. */
	maxFailures?: number;
	/** Timer injection for tests; defaults to `setTimeout`/`clearTimeout` (unref'ed). */
	setTimer?: (callback: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
}

export interface PrecomputeStatus {
	state: PrecomputeState;
	/** Age of the running or ready job. */
	ageMs?: number;
	/** Why the last job was thrown away or failed. */
	lastDiscard?: string;
	jobsThisCycle: number;
	failures: number;
}

interface Job {
	snapshot: Snapshot;
	controller: AbortController;
	startedAt: number;
	timer: unknown;
	/** Set once the job ended in any way (ready, failed, expired or discarded); later events are ignored. */
	finished: boolean;
	generated?: Generated;
	readyAt?: number;
	discardReason?: string;
	failReason?: string;
	/** Resolves when the job finishes. Never rejects. */
	done: Promise<void>;
	finish: () => void;
}

/**
 * One background job that writes the state summary ahead of the compaction. Every error is caught here
 * (no unhandled rejections); a degraded state counts as a failure.
 */
export class Precomputer {
	private readonly opts: Required<Omit<PrecomputerOptions, "setTimer" | "clearTimer">> &
		Pick<PrecomputerOptions, "setTimer" | "clearTimer">;
	private job: Job | undefined;
	private jobs = 0;
	private failures = 0;
	private paused = false;
	private lastDiscard: string | undefined;
	private discarded: Discarded[] = [];

	constructor({ deadlineMs = 180_000, maxJobsPerCycle = 2, maxFailures = 2, ...rest }: PrecomputerOptions) {
		this.opts = { deadlineMs, maxJobsPerCycle, maxFailures, ...rest };
	}

	state(): PrecomputeState {
		if (this.job) return this.job.generated ? "ready" : "running";
		return this.paused ? "paused" : "idle";
	}

	/** True when the per-cycle job budget is spent. */
	get budgetExhausted(): boolean {
		return this.jobs >= this.opts.maxJobsPerCycle;
	}

	status(): PrecomputeStatus {
		return {
			state: this.state(),
			ageMs: this.job ? this.opts.now() - this.job.startedAt : undefined,
			lastDiscard: this.lastDiscard,
			jobsThisCycle: this.jobs,
			failures: this.failures,
		};
	}

	/** Start a job for `snapshot`. False when one is already running/ready, the budget is spent or the precompute is paused. */
	start(snapshot: Snapshot): boolean {
		if (this.state() !== "idle" || this.budgetExhausted) return false;
		this.jobs++;
		const controller = new AbortController();
		let finish!: () => void;
		const done = new Promise<void>((resolve) => (finish = resolve));
		const job: Job = { snapshot, controller, startedAt: this.opts.now(), timer: undefined, finished: false, done, finish };
		this.job = job;

		const setTimer = this.opts.setTimer ?? ((cb, ms) => {
			const handle = setTimeout(cb, ms);
			handle.unref?.();
			return handle;
		});
		job.timer = setTimer(() => this.fail(job, `deadline of ${Math.round(this.opts.deadlineMs / 1000)}s exceeded`, true), this.opts.deadlineMs);

		(async () => this.opts.run(snapshot, controller.signal))().then(
			(generated) => this.settle(job, generated),
			(error: unknown) => this.fail(job, error instanceof Error ? error.message : String(error), false),
		);
		return true;
	}

	/**
	 * The prepared state: immediately when ready, after waiting when running (an abort of `signal` stops the
	 * waiting, not the job), undefined when there is none or it failed. The job is consumed: use `discardTaken`
	 * if the result then turns out not to be adoptable.
	 */
	async take(signal?: AbortSignal): Promise<Taken | undefined> {
		const t0 = this.opts.now();
		const job = this.job;
		if (!job || signal?.aborted) return undefined;
		if (!job.generated) {
			const stop = new AbortController(); // removes the listener once the wait is over
			const aborted = new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true, signal: stop.signal }));
			await Promise.race([job.done, aborted]);
			stop.abort();
			if (signal?.aborted && !job.generated) return undefined;
		}
		if (this.job !== job || !job.generated) return undefined;
		this.job = undefined;
		return {
			snapshot: job.snapshot,
			generated: job.generated,
			waitedMs: this.opts.now() - t0,
			preparedMs: (job.readyAt ?? this.opts.now()) - job.startedAt,
		};
	}

	/** Abort the job (running or ready), drop it and keep the usage already paid for. */
	discard(reason: string): void {
		const job = this.job;
		if (!job) return;
		this.job = undefined;
		this.lastDiscard = reason;
		this.record(job, reason);
		if (!job.finished) {
			job.finished = true;
			job.discardReason = reason;
			this.end(job);
			job.controller.abort();
		}
	}

	/** Account for a taken result that was not adopted (invalid after the wait, or the compaction failed). */
	discardTaken(taken: Taken, reason: string): void {
		this.lastDiscard = reason;
		if (taken.generated.usage) this.discarded.push({ usage: taken.generated.usage, reason, model: taken.generated.model });
	}

	/** Usage of the discarded jobs since the last call, for the `auto-compact-discarded` draft. */
	drainDiscarded(): Discarded[] {
		const out = this.discarded;
		this.discarded = [];
		return out;
	}

	/** After a compaction: a fresh budget, no pause, and nothing left over from before it. */
	cycleReset(): void {
		this.discard("a compaction happened");
		this.jobs = 0;
		this.failures = 0;
		this.paused = false;
	}

	/** Lift the pause (`/autocompact precompute on`). */
	resume(): void {
		this.failures = 0;
		this.paused = false;
	}

	private end(job: Job): void {
		if (job.timer !== undefined) (this.opts.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout)))(job.timer);
		job.finish();
	}

	/** Keep the usage of a result nobody will adopt. */
	private record(job: Job, reason: string): void {
		const usage = job.generated?.usage;
		if (usage) this.discarded.push({ usage, reason, model: job.generated?.model });
	}

	private settle(job: Job, generated: Generated): void {
		if (job.finished) {
			// ended while the call was in flight (expired or discarded): it still cost money
			job.generated = generated;
			this.record(job, job.discardReason ?? job.failReason ?? "discarded");
			return;
		}
		if (generated.degraded) {
			job.generated = undefined;
			this.fail(job, generated.degraded, false, generated);
			return;
		}
		job.generated = generated;
		job.readyAt = this.opts.now();
		job.finished = true;
		this.end(job);
	}

	private fail(job: Job, reason: string, expired: boolean, generated?: Generated): void {
		if (job.finished) return;
		job.finished = true;
		job.failReason = reason;
		if (generated) {
			job.generated = generated;
			this.record(job, reason);
			job.generated = undefined;
		}
		this.end(job);
		if (expired) job.controller.abort();
		if (this.job === job) this.job = undefined;
		this.lastDiscard = reason;
		if (++this.failures >= this.opts.maxFailures) this.paused = true;
	}
}
