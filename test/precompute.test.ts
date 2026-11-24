import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";
import type { Generated } from "../src/summarize.ts";
import {
	MIN_GROWTH_TOKENS,
	Precomputer,
	type PrecomputerOptions,
	type Snapshot,
	type ValidateInput,
	aheadKeep,
	compactAt,
	createSnapshot,
	growthFor,
	hashEntries,
	leadFor,
	shouldStart,
	validateSnapshot,
} from "../src/precompute.ts";

// ---------------------------------------------------------------------------------------------------
// Trigger

/** The loop guard of index.ts, as it was before compactAt existed. */
const guardFires = (tokens: number, threshold: number, baseline: number | null, growth: number) =>
	tokens > threshold && (baseline === null || tokens - baseline >= growth);

test("growthFor keeps the 10k floor and scales with the threshold", () => {
	assert.equal(growthFor(20_000), MIN_GROWTH_TOKENS);
	assert.equal(growthFor(40_000), 10_000);
	assert.equal(growthFor(200_000), 50_000);
});

test("tokens > compactAt is exactly the loop guard, edges included", () => {
	for (const [threshold, baseline, growth] of [
		[40_000, null, 10_000],
		[40_000, 5_000, 10_000], // baseline + growth < threshold: the threshold rules
		[40_000, 35_000, 10_000], // baseline + growth > threshold: the growth rules
		[40_000, 30_000, 10_000], // baseline + growth == threshold
		[200_000, 120_000, 50_000],
	] as const) {
		const at = compactAt(threshold, baseline, growth);
		for (let tokens = at - 3; tokens <= at + 3; tokens++) {
			assert.equal(tokens > at, guardFires(tokens, threshold, baseline, growth), `${threshold}/${baseline}/${growth} @ ${tokens}`);
		}
	}
	assert.equal(compactAt(40_000, null, 10_000), 40_000);
	assert.equal(compactAt(40_000, 35_000, 10_000), 44_999);
	assert.equal(compactAt(40_000, 5_000, 10_000), 40_000);
});

test("leadFor is half the growth", () => {
	assert.equal(leadFor(10_000), 5_000);
	assert.equal(leadFor(50_000), 25_000);
	assert.equal(leadFor(7), 3);
});

const start = (over: Partial<Parameters<typeof shouldStart>[0]> = {}) =>
	shouldStart({ tokens: 36_000, threshold: 40_000, baseline: null, awaitingBaseline: false, growth: 10_000, state: "idle", ...over });

test("shouldStart fires inside the lead window before compactAt", () => {
	assert.equal(start({ tokens: 35_000 }), false); // exactly compactAt - lead: not yet
	assert.equal(start({ tokens: 35_001 }), true);
	assert.equal(start({ tokens: 40_000 }), true); // still not above compactAt
	assert.equal(start({ tokens: 20_000 }), false);
});

test("shouldStart is false while awaiting the baseline, past compactAt, or while busy/paused/out of budget", () => {
	assert.equal(start({ awaitingBaseline: true }), false);
	assert.equal(start({ tokens: 40_001 }), false);
	for (const state of ["running", "ready", "paused"] as const) assert.equal(start({ state }), false, state);
	assert.equal(start({ budgetExhausted: true }), false);
});

test("shouldStart follows the baseline-based compactAt", () => {
	// baseline 35k + growth 10k: compactAt is 44_999, lead window starts above 39_999
	assert.equal(start({ baseline: 35_000, tokens: 39_999 }), false);
	assert.equal(start({ baseline: 35_000, tokens: 40_000 }), true);
	assert.equal(start({ baseline: 35_000, tokens: 45_000 }), false);
});

test("aheadKeep shrinks the kept tail by the distance to the trigger, never below half", () => {
	assert.equal(aheadKeep(20_000, 38_000, 40_000), 18_000);
	assert.equal(aheadKeep(20_000, 40_000, 40_000), 20_000);
	assert.equal(aheadKeep(20_000, 20_000, 40_000), 10_000); // floor(keepRecent / 2)
	assert.equal(aheadKeep(20_000, 1_000, 40_000), 10_000);
});

// ---------------------------------------------------------------------------------------------------
// Snapshot

const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 1 });
const assistant = (text: string): AgentMessage =>
	({ role: "assistant", content: [{ type: "text", text }], timestamp: 1 }) as unknown as AgentMessage;
const entry = (id: string, type: string, ...messages: AgentMessage[]) =>
	({ sourceEntry: { id, type }, messages }) as unknown as ProjectedSessionEntry;
const msg = (id: string, m: AgentMessage) => entry(id, "message", m);
const hundred = () => 100;

// e0 .. e5 alternate user/assistant: with keep 250 the cut is at e3 (e0..e2 are summarized)
const history = (): ProjectedSessionEntry[] => [
	msg("e0", user("one")),
	msg("e1", assistant("two")),
	msg("e2", user("three")),
	msg("e3", assistant("four")),
	msg("e4", user("five")),
	msg("e5", assistant("six")),
];

const snap = (entries = history(), settingsKey = "m|off|m") => {
	const s = createSnapshot(entries, { keep: 250, estimate: hundred, settingsKey, startedAt: 7 });
	assert.ok(s);
	return s;
};
const check = (s: Snapshot, entries: ProjectedSessionEntry[], over: Partial<ValidateInput> = {}) =>
	validateSnapshot(s, entries, { settingsKey: "m|off|m", keepRecent: 250, lead: 100, estimate: hundred, ...over });

test("createSnapshot records the span, its entry ids and a fingerprint", () => {
	const s = snap();
	assert.equal(s.firstKeptEntryId, "e3");
	assert.deepEqual(s.entryIds, ["e0", "e1", "e2"]);
	assert.equal(s.messages.length, 3);
	assert.equal(s.previousId, undefined);
	assert.equal(s.startedAt, 7);
	assert.equal(s.hash, hashEntries(history().slice(0, 3)));
	assert.equal(createSnapshot(history(), { keep: 10_000, estimate: hundred, settingsKey: "k", startedAt: 0 }), undefined);
});

test("hashEntries changes when a message or an id changes", () => {
	const base = hashEntries(history());
	assert.equal(hashEntries(history()), base);
	assert.notEqual(hashEntries([msg("e0", user("edited")), ...history().slice(1)]), base);
	assert.notEqual(hashEntries([msg("x0", user("one")), ...history().slice(1)]), base);
});

test("validateSnapshot accepts a context that only grew at the tail", () => {
	const s = snap();
	assert.deepEqual(check(s, history()), { ok: true });
	assert.deepEqual(check(s, [...history(), msg("e6", user("seven")), msg("e7", assistant("eight"))], { lead: 300 }), { ok: true });
});

test("validateSnapshot works after a previous compaction", () => {
	const summary = { role: "compactionSummary", summary: "old", tokensBefore: 1, timestamp: 1 } as unknown as AgentMessage;
	const withCompaction = (...rest: ProjectedSessionEntry[]) => [entry("c0", "compaction", summary), msg("k1", user("kept")), ...rest];
	const s = snap(withCompaction(...history().slice(1)));
	assert.equal(s.previousId, "c0");
	assert.deepEqual(check(s, withCompaction(...history().slice(1))), { ok: true });
	// a newer compaction replaced c0
	const newer = entry("c1", "compaction", summary);
	assert.deepEqual(check(s, [newer, ...history().slice(3)]), { ok: false, reason: "another compaction happened in between" });
});

const reason = (result: ReturnType<typeof check>) => (result.ok ? "" : result.reason);

test("validateSnapshot rejects an intermediate compaction", () => {
	const summary = { role: "compactionSummary", summary: "new", tokensBefore: 1, timestamp: 1 } as unknown as AgentMessage;
	const result = check(snap(), [entry("c9", "compaction", summary), ...history().slice(3)]);
	assert.equal(result.ok, false);
	assert.match(reason(result), /another compaction/);
});

test("validateSnapshot rejects a context_edit on a snapshot entry (hash)", () => {
	const edited = history();
	edited[1] = msg("e1", assistant("two, edited"));
	const result = check(snap(), edited);
	assert.equal(result.ok, false);
	assert.match(reason(result), /edited/);
	// an edit on the kept tail does not matter
	const tailEdit = history();
	tailEdit[4] = msg("e4", user("five, edited"));
	assert.deepEqual(check(snap(), tailEdit), { ok: true });
});

test("validateSnapshot rejects a different branch (ids)", () => {
	const other = [history()[0], msg("f1", assistant("two")), ...history().slice(2)];
	assert.match(reason(check(snap(), other)), /branch changed/);
	assert.match(reason(check(snap(), history().slice(0, 2))), /branch changed/); // shorter than the snapshot
});

test("validateSnapshot rejects a vanished firstKeptEntryId", () => {
	const gone = [...history().slice(0, 3), msg("e9", assistant("four")), ...history().slice(4)];
	assert.match(reason(check(snap(), gone)), /first kept entry/);
	assert.match(reason(check(snap(), history().slice(0, 3))), /first kept entry/);
});

test("validateSnapshot rejects changed settings", () => {
	assert.match(reason(check(snap(), history(), { settingsKey: "other|off|m" })), /settings changed/);
});

test("validateSnapshot rejects a kept tail that grew too large", () => {
	const grown = [...history(), msg("e6", user("seven")), msg("e7", assistant("eight")), msg("e8", user("nine"))];
	// tail e3..e8 = 600 tokens
	assert.deepEqual(check(snap(), grown, { keepRecent: 250, lead: 350 }), { ok: true });
	assert.match(reason(check(snap(), grown, { keepRecent: 250, lead: 349 })), /kept tail grew/);
});

// ---------------------------------------------------------------------------------------------------
// Precomputer

const unhandled: unknown[] = [];
process.on("unhandledRejection", (reason) => unhandled.push(reason));
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

const usage = (total: number) => ({ input: total, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: total }) as unknown as Usage;
const generated = (total = 1, extra: Partial<Generated> = {}): Generated => ({ state: "state", usage: usage(total), model: "m/x", thinking: "off", ...extra });

interface Call {
	snapshot: Snapshot;
	signal: AbortSignal;
	resolve: (value: Generated) => void;
	reject: (error: Error) => void;
}

function rig(options: Partial<PrecomputerOptions> = {}) {
	const calls: Call[] = [];
	let time = 1_000;
	const timers: { callback: () => void; at: number; cleared: boolean }[] = [];
	const precomputer = new Precomputer({
		run: (snapshot, signal) =>
			new Promise<Generated>((resolve, reject) => {
				calls.push({ snapshot, signal, resolve, reject });
				// a well-behaved runner rejects when aborted
				signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			}),
		now: () => time,
		setTimer: (callback, ms) => {
			const timer = { callback, at: time + ms, cleared: false };
			timers.push(timer);
			return timer;
		},
		clearTimer: (handle) => {
			(handle as { cleared: boolean }).cleared = true;
		},
		...options,
	});
	const advance = (ms: number) => {
		time += ms;
		for (const timer of timers) {
			if (timer.cleared || timer.at > time) continue;
			timer.cleared = true;
			timer.callback();
		}
	};
	return { precomputer, calls, advance };
}

const fresh = () => snap();

test("Precomputer runs one job at a time", async () => {
	const { precomputer, calls } = rig();
	assert.equal(precomputer.state(), "idle");
	assert.equal(precomputer.start(fresh()), true);
	assert.equal(precomputer.state(), "running");
	assert.equal(precomputer.start(fresh()), false);
	calls[0].resolve(generated());
	await tick();
	assert.equal(precomputer.state(), "ready");
	assert.equal(precomputer.start(fresh()), false); // a ready job also blocks a new one
	assert.equal(calls.length, 1);
});

test("take on a ready job returns it at once without running again", async () => {
	const { precomputer, calls, advance } = rig();
	precomputer.start(fresh());
	advance(4_000);
	calls[0].resolve(generated(5));
	await tick();
	advance(10_000);
	const taken = await precomputer.take();
	assert.equal(taken?.waitedMs, 0);
	assert.equal(taken?.preparedMs, 4_000);
	assert.equal(taken?.generated.state, "state");
	assert.equal(taken?.snapshot.firstKeptEntryId, "e3");
	assert.equal(calls.length, 1);
	assert.equal(precomputer.state(), "idle"); // consumed
	assert.equal(await precomputer.take(), undefined);
});

test("take on a running job waits for it and reports how long", async () => {
	const { precomputer, calls, advance } = rig();
	precomputer.start(fresh());
	const pending = precomputer.take();
	advance(2_500);
	calls[0].resolve(generated());
	const taken = await pending;
	assert.equal(taken?.waitedMs, 2_500);
	assert.equal(taken?.preparedMs, 2_500);
});

test("aborting the signal of take stops the wait but not the job", async () => {
	const { precomputer, calls } = rig();
	precomputer.start(fresh());
	const controller = new AbortController();
	const pending = precomputer.take(controller.signal);
	controller.abort();
	assert.equal(await pending, undefined);
	assert.equal(calls[0].signal.aborted, false);
	assert.equal(precomputer.state(), "running");
	calls[0].resolve(generated());
	await tick();
	assert.equal(precomputer.state(), "ready");
	assert.ok(await precomputer.take());
	// an already aborted signal does not even wait
	precomputer.cycleReset();
	precomputer.start(fresh());
	assert.equal(await precomputer.take(AbortSignal.abort()), undefined);
	assert.equal(precomputer.state(), "running");
});

test("the deadline aborts the job and counts as a failure", async () => {
	const { precomputer, calls, advance } = rig({ deadlineMs: 180_000 });
	precomputer.start(fresh());
	const pending = precomputer.take();
	advance(179_999);
	assert.equal(calls[0].signal.aborted, false);
	advance(1);
	assert.equal(calls[0].signal.aborted, true);
	assert.equal(await pending, undefined);
	assert.equal(precomputer.state(), "idle");
	assert.equal(precomputer.status().failures, 1);
	assert.match(precomputer.status().lastDiscard ?? "", /deadline of 180s/);
});

test("a result that arrives after the deadline still has its usage recorded", async () => {
	// a runner that ignores the abort and resolves late
	let late: ((g: Generated) => void) | undefined;
	const slow = new Precomputer({
		run: () => new Promise<Generated>((resolve) => (late = resolve)),
		now: () => 0,
		deadlineMs: 10,
	});
	slow.start(fresh());
	await new Promise((resolve) => setTimeout(resolve, 30)); // real timers: the default timer path
	assert.equal(slow.state(), "idle");
	late?.(generated(9));
	await tick();
	const drained = slow.drainDiscarded();
	assert.equal(drained.length, 1);
	assert.equal(drained[0].usage.totalTokens, 9);
	assert.match(drained[0].reason, /deadline/);
});

test("two failures pause the precompute until cycleReset or resume", async () => {
	const { precomputer, calls } = rig({ maxJobsPerCycle: 10 });
	precomputer.start(fresh());
	calls[0].reject(new Error("boom"));
	await tick();
	assert.equal(precomputer.state(), "idle");
	precomputer.start(fresh());
	calls[1].resolve(generated(1, { degraded: "model down" })); // degraded = failure
	await tick();
	assert.equal(precomputer.state(), "paused");
	assert.equal(precomputer.status().lastDiscard, "model down");
	assert.equal(precomputer.start(fresh()), false);
	precomputer.resume();
	assert.equal(precomputer.state(), "idle");
	assert.equal(precomputer.start(fresh()), true);

	// cycleReset lifts the pause too
	const other = rig({ maxJobsPerCycle: 10 });
	for (let i = 0; i < 2; i++) {
		other.precomputer.start(fresh());
		other.calls[i].reject(new Error("x"));
		await tick();
	}
	assert.equal(other.precomputer.state(), "paused");
	other.precomputer.cycleReset();
	assert.equal(other.precomputer.state(), "idle");
});

test("maxJobsPerCycle is respected and cycleReset restores the budget", async () => {
	const { precomputer, calls } = rig({ maxJobsPerCycle: 2 });
	for (let i = 0; i < 2; i++) {
		assert.equal(precomputer.budgetExhausted, false);
		assert.equal(precomputer.start(fresh()), true);
		calls[i].resolve(generated());
		await tick();
		assert.ok(await precomputer.take());
	}
	assert.equal(precomputer.budgetExhausted, true);
	assert.equal(precomputer.start(fresh()), false);
	assert.equal(calls.length, 2);
	precomputer.cycleReset();
	assert.equal(precomputer.budgetExhausted, false);
	assert.equal(precomputer.start(fresh()), true);
});

test("discard aborts a running job and accumulates the usage of a ready one", async () => {
	const { precomputer, calls } = rig({ maxJobsPerCycle: 10 });
	precomputer.start(fresh());
	precomputer.discard("model changed");
	assert.equal(calls[0].signal.aborted, true);
	assert.equal(precomputer.state(), "idle");
	assert.equal(precomputer.status().failures, 0); // not a failure
	await tick();
	assert.deepEqual(precomputer.drainDiscarded(), []); // nothing known yet

	precomputer.start(fresh());
	calls[1].resolve(generated(7));
	await tick();
	precomputer.discard("branch changed");
	assert.equal(precomputer.state(), "idle");
	assert.equal(precomputer.status().lastDiscard, "branch changed");
	const drained = precomputer.drainDiscarded();
	assert.equal(drained.length, 1);
	assert.equal(drained[0].usage.totalTokens, 7);
	assert.equal(drained[0].reason, "branch changed");
	assert.equal(drained[0].model, "m/x");
	assert.deepEqual(precomputer.drainDiscarded(), []); // drained once
	precomputer.discard("nothing to discard"); // a no-op
});

test("discardTaken records the usage of a result that was not adopted", async () => {
	const { precomputer, calls } = rig();
	precomputer.start(fresh());
	calls[0].resolve(generated(3));
	await tick();
	const taken = await precomputer.take();
	assert.ok(taken);
	precomputer.discardTaken(taken, "settings changed");
	assert.deepEqual(precomputer.drainDiscarded().map((d) => [d.usage.totalTokens, d.reason]), [[3, "settings changed"]]);
});

test("a discarded job whose call resolves late still has its usage recorded", async () => {
	let late: ((g: Generated) => void) | undefined;
	const precomputer = new Precomputer({ run: () => new Promise<Generated>((resolve) => (late = resolve)), now: () => 0 });
	precomputer.start(fresh());
	precomputer.discard("session closed");
	late?.(generated(4));
	await tick();
	assert.deepEqual(precomputer.drainDiscarded().map((d) => [d.usage.totalTokens, d.reason]), [[4, "session closed"]]);
});

test("a synchronously throwing runner is a failure, not an exception", async () => {
	const precomputer = new Precomputer({
		run: () => {
			throw new Error("sync boom");
		},
		now: () => 0,
	});
	assert.equal(precomputer.start(fresh()), true);
	await tick();
	assert.equal(precomputer.state(), "idle");
	assert.equal(precomputer.status().lastDiscard, "sync boom");
});

test("status reports state, age and the last discard reason", () => {
	const { precomputer, advance } = rig();
	assert.deepEqual(precomputer.status(), { state: "idle", ageMs: undefined, lastDiscard: undefined, jobsThisCycle: 0, failures: 0 });
	precomputer.start(fresh());
	advance(1_500);
	assert.equal(precomputer.status().ageMs, 1_500);
	assert.equal(precomputer.status().state, "running");
	precomputer.discard("model changed");
	assert.equal(precomputer.status().lastDiscard, "model changed");
});

test("the precomputer leaves no unhandled rejection behind", async () => {
	const { precomputer, calls, advance } = rig({ maxJobsPerCycle: 10, maxFailures: 100 });
	precomputer.start(fresh());
	calls[0].reject(new Error("fails"));
	await tick();
	precomputer.start(fresh());
	precomputer.discard("abort path"); // the runner rejects on abort
	precomputer.start(fresh());
	advance(180_000); // deadline path: the runner rejects on abort
	precomputer.start(fresh());
	calls[3].reject(new Error("late failure"));
	calls[3].resolve(generated());
	await precomputer.take();
	await tick();
	await new Promise((resolve) => setTimeout(resolve, 20)); // unhandledRejection fires after the microtasks drain
	assert.deepEqual(unhandled, []);
});
