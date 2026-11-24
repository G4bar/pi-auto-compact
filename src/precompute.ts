import { createHash } from "node:crypto";
import type { Usage } from "@earendil-works/pi-ai";
import type { ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";
import { type EstimateTokens, type Span, latestCompactionIndex, planSpan } from "./span.ts";
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

/** Whether `tokens` is inside the precompute lead window before `trigger` (and not past it). */
export function inLeadWindow(tokens: number, trigger: number, growth: number): boolean {
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
export interface Snapshot extends Omit<Span, "covered"> {
	/** Context entries replaced by the span (those after `previous`, before `firstKeptEntryId`). */
	entryIds: string[];
	/** Fingerprint of those entries' ids and model-visible messages. */
	hash: string;
	/** `settingsKey(...)` of the summary settings in force when the job started. */
	settingsKey: string;
}

/** sha256 of the ids and messages of `entries`: changes with any `context_edit` on them. */
export function hashEntries(entries: readonly ProjectedSessionEntry[]): string {
	return createHash("sha256")
		.update(JSON.stringify(entries.map((e) => [e.sourceEntry.id, e.messages])))
		.digest("hex");
}

export interface CreateSnapshotInput {
	/** Tokens to keep verbatim (see `aheadKeep`). */
	keep: number;
	estimate: EstimateTokens;
	settingsKey: string;
}

/** Plan the span with `planSpan` and fingerprint it; undefined when there is nothing to compact. */
export function createSnapshot(entries: readonly ProjectedSessionEntry[], { keep, estimate, settingsKey }: CreateSnapshotInput): Snapshot | undefined {
	const span = planSpan(entries, keep, estimate);
	if (!span) return undefined;
	return {
		entryIds: span.covered.map((e) => e.sourceEntry.id),
		hash: hashEntries(span.covered),
		firstKeptEntryId: span.firstKeptEntryId,
		messages: span.messages,
		previous: span.previous,
		settingsKey,
	};
}

export interface ValidateInput {
	/** `settingsKey(...)` now. */
	settingsKey: string;
	keepRecent: number;
	/** How much the kept tail may exceed `keepRecent`. */
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
	const prevIndex = latestCompactionIndex(entries);
	const currentPrevious = prevIndex >= 0 ? entries[prevIndex].sourceEntry.id : undefined;
	if (currentPrevious !== snapshot.previous?.id) return { ok: false, reason: "another compaction happened in between" };

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

export type JobRunner = (snapshot: Snapshot, signal: AbortSignal) => Promise<Generated>;

export type AdoptResult =
	| { status: "adopted"; taken: Taken }
	| { status: "discarded"; reason: string }
	| { status: "aborted" }
	| { status: "none" };

export interface PrecomputerOptions {
	/** Writes the state for a snapshot. Must honor `signal`; may reject. */
	run?: JobRunner;
	now?: () => number;
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
	endReason?: string;
	/** Resolves when the job finishes. Never rejects. */
	done: Promise<void>;
	finish: () => void;
}

/**
 * One background job that writes the state summary ahead of the compaction. Every error is caught here
 * (no unhandled rejections); a degraded state counts as a failure.
 */
export class Precomputer {
	private readonly run: JobRunner | undefined;
	private readonly now: () => number;
	private readonly deadlineMs: number;
	private readonly maxJobsPerCycle: number;
	private readonly maxFailures: number;
	private readonly setTimer: (callback: () => void, ms: number) => unknown;
	private readonly clearTimer: (handle: unknown) => void;
	private job: Job | undefined;
	private jobs = 0;
	private failures = 0;
	private lastDiscard: string | undefined;
	private discarded: Discarded[] = [];

	constructor({
		run,
		now = () => Date.now(),
		deadlineMs = 180_000,
		maxJobsPerCycle = 2,
		maxFailures = 2,
		setTimer = (callback, ms) => {
			const handle = setTimeout(callback, ms);
			handle.unref?.();
			return handle;
		},
		clearTimer = (handle) => clearTimeout(handle as NodeJS.Timeout),
	}: PrecomputerOptions = {}) {
		this.run = run;
		this.now = now;
		this.deadlineMs = deadlineMs;
		this.maxJobsPerCycle = maxJobsPerCycle;
		this.maxFailures = maxFailures;
		this.setTimer = setTimer;
		this.clearTimer = clearTimer;
	}

	state(): PrecomputeState {
		if (this.job) return this.job.generated ? "ready" : "running";
		return this.failures >= this.maxFailures ? "paused" : "idle";
	}

	/** True when the per-cycle job budget is spent. */
	get budgetExhausted(): boolean {
		return this.jobs >= this.maxJobsPerCycle;
	}

	/** True when a new job can be started right now. */
	get canStart(): boolean {
		return this.state() === "idle" && !this.budgetExhausted;
	}

	/** True when a job is currently running or ready. */
	get hasJob(): boolean {
		return this.job !== undefined;
	}

	status(): PrecomputeStatus {
		return {
			state: this.state(),
			ageMs: this.job ? this.now() - this.job.startedAt : undefined,
			lastDiscard: this.lastDiscard,
			jobsThisCycle: this.jobs,
			failures: this.failures,
		};
	}

	/** Start a job for `snapshot`. False when one is already running/ready, the budget is spent or the precompute is paused. */
	start(snapshot: Snapshot, run?: JobRunner): boolean {
		const runner = run ?? this.run;
		if (!runner) throw new Error("no runner for precompute job");
		if (!this.canStart) return false;
		this.jobs++;
		const controller = new AbortController();
		let finish!: () => void;
		const done = new Promise<void>((resolve) => (finish = resolve));
		const job: Job = { snapshot, controller, startedAt: this.now(), timer: undefined, finished: false, done, finish };
		this.job = job;

		job.timer = this.setTimer(
			() => this.fail(job, `deadline of ${Math.round(this.deadlineMs / 1000)}s exceeded`, true),
			this.deadlineMs,
		);

		(async () => runner(snapshot, controller.signal))().then(
			(generated) => this.settle(job, generated),
			(error: unknown) => this.fail(job, error instanceof Error ? error.message : String(error), false),
		);
		return true;
	}

	/** Discard the current job if `validate` rejects its snapshot, returning the rejection reason. */
	dropIfInvalid(validate: (snapshot: Snapshot) => Validation): string | undefined {
		if (!this.job) return undefined;
		const verdict = validate(this.job.snapshot);
		if (!verdict.ok) {
			this.discard(verdict.reason);
			return verdict.reason;
		}
		return undefined;
	}

	/**
	 * The prepared state: immediately when ready, after waiting when running (an abort of `signal` stops the
	 * waiting, not the job), undefined when there is none or it failed. The job is consumed: use `discardTaken`
	 * if the result then turns out not to be adoptable.
	 */
	async take(signal?: AbortSignal): Promise<Taken | undefined> {
		const t0 = this.now();
		const job = this.job;
		if (!job || signal?.aborted) return undefined;
		if (!job.generated) {
			if (signal) {
				const stop = new AbortController(); // removes the listener once the wait is over
				const aborted = new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true, signal: stop.signal }));
				await Promise.race([job.done, aborted]);
				stop.abort();
			} else {
				await job.done;
			}
			if (signal?.aborted) return undefined;
		}
		if (this.job !== job || !job.generated) return undefined;
		this.job = undefined;
		return {
			snapshot: job.snapshot,
			generated: job.generated,
			waitedMs: this.now() - t0,
			preparedMs: (job.readyAt ?? this.now()) - job.startedAt,
		};
	}

	/**
	 * Validate, wait for (if running), re-validate, and adopt the current job in one step.
	 * `onWait` runs once a valid job is present, just before taking/awaiting it.
	 */
	async adopt(
		validate: (snapshot: Snapshot) => Validation,
		signal?: AbortSignal,
		onWait?: () => void,
	): Promise<AdoptResult> {
		if (!this.job) return { status: "none" };
		const dropped = this.dropIfInvalid(validate);
		if (dropped !== undefined) return { status: "discarded", reason: dropped };
		if (signal?.aborted) return { status: "aborted" };
		onWait?.();
		const taken = await this.take(signal);
		if (signal?.aborted) return { status: "aborted" };
		if (!taken) return { status: "none" };
		const verdict = validate(taken.snapshot);
		if (!verdict.ok) {
			this.discardTaken(taken, verdict.reason);
			return { status: "discarded", reason: verdict.reason };
		}
		return { status: "adopted", taken };
	}

	/** Abort the job (running or ready), drop it and keep the usage already paid for. */
	discard(reason: string): void {
		const job = this.job;
		if (!job) return;
		this.job = undefined;
		this.lastDiscard = reason;
		this.recordUsage(job.generated, reason);
		if (!job.finished) {
			job.finished = true;
			job.endReason = reason;
			this.end(job);
			job.controller.abort();
		}
	}

	/** Account for a taken result that was not adopted (invalid after the wait, or the compaction failed). */
	discardTaken(taken: Taken, reason: string): void {
		this.lastDiscard = reason;
		this.recordUsage(taken.generated, reason);
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
	}

	/** Lift the pause (`/autocompact precompute on`). */
	resume(): void {
		this.failures = 0;
	}

	private end(job: Job): void {
		if (job.timer !== undefined) this.clearTimer(job.timer);
		job.finish();
	}

	/** Keep the usage of a result nobody will adopt. */
	private recordUsage(generated: Generated | undefined, reason: string): void {
		if (generated?.usage) this.discarded.push({ usage: generated.usage, reason, model: generated.model });
	}

	private settle(job: Job, generated: Generated): void {
		if (job.finished) {
			// ended while the call was in flight (expired or discarded): it still cost money
			this.recordUsage(generated, job.endReason ?? "discarded");
			return;
		}
		if (generated.degraded) {
			this.fail(job, generated.degraded, false, generated);
			return;
		}
		job.generated = generated;
		job.readyAt = this.now();
		job.finished = true;
		this.failures = 0; // the pause counts consecutive failures
		this.end(job);
	}

	private fail(job: Job, reason: string, expired: boolean, generated?: Generated): void {
		if (job.finished) return;
		job.finished = true;
		job.endReason = reason;
		this.recordUsage(generated, reason);
		this.end(job);
		if (expired) job.controller.abort();
		if (this.job === job) this.job = undefined;
		this.lastDiscard = reason;
		this.failures++;
	}
}
