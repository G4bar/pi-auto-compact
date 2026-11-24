import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";
import {
	MIN_GROWTH_TOKENS,
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
