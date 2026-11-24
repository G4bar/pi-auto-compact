import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";
import { planSpan } from "../src/span.ts";

const agentDir = mkdtempSync(join(tmpdir(), "ac-index-agent-"));
const cwd = mkdtempSync(join(tmpdir(), "ac-index-cwd-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const configFile = join(agentDir, "auto-compact.json");

// Numbers: window 200k at 20% = 40k threshold, growth 10k, lead 5k, keepRecent 20k (pi's default);
// every entry is 4000 chars = 1000 estimated tokens.
const WINDOW = 200_000;
const THRESHOLD = 40_000;
const KEEP_RECENT = 20_000;
// aheadKeep(KEEP_RECENT, 36k, 40k): what a job started at 36k keeps verbatim
const AHEAD_KEEP = 16_000;

const MODEL = { provider: "p", id: "m", contextWindow: WINDOW, maxTokens: 8_000, reasoning: false };
const USAGE = { input: 11, output: 22, cacheRead: 0, cacheWrite: 0, totalTokens: 33, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

// ---------------------------------------------------------------------------------------------------
// Fake conversation

const BODY = "x".repeat(4_000);
const message = (i: number, text = BODY): AgentMessage =>
	i % 2 === 0
		? { role: "user", content: `MSG-${i} ${text}`, timestamp: i }
		: ({ role: "assistant", content: [{ type: "text", text }], timestamp: i } as unknown as AgentMessage);
const entryAt = (i: number, text?: string) => ({ sourceEntry: { id: `e${i}`, type: "message" }, messages: [message(i, text)] }) as unknown as ProjectedSessionEntry;
const history = (count: number): ProjectedSessionEntry[] => Array.from({ length: count }, (_, i) => entryAt(i));

const expectedCut = (entries: ProjectedSessionEntry[], keep = KEEP_RECENT) => {
	const span = planSpan(entries, keep, estimateTokens);
	assert.ok(span);
	return span.firstKeptEntryId;
};

// ---------------------------------------------------------------------------------------------------
// Fake pi + ctx

type Behavior = "ok" | "manual" | { fail: string };
interface Call {
	signal?: AbortSignal;
	resolve?: (text: string) => void;
}

const sleep = () => new Promise<void>((resolve) => setImmediate(resolve));
const settle = async () => {
	for (let i = 0; i < 5; i++) await sleep();
};

interface Rig {
	calls: Call[];
	notes: string[];
	behavior: Behavior[];
	ctx: { model: object };
	fire: (event: string, payload?: object) => Promise<any>;
	command: (args: string) => Promise<void>;
	completions: (prefix: string) => string[];
	turnEnd: (entries: ProjectedSessionEntry[], tokens: number, extra?: object) => Promise<any>;
}

function setup(config: object = {}): Rig {
	writeFileSync(configFile, JSON.stringify(config));
	const handlers = new Map<string, ((event: any, ctx: any) => unknown)[]>();
	let command: any;
	const pi = {
		on: (name: string, handler: (event: any, ctx: any) => unknown) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		registerCommand: (_name: string, options: unknown) => (command = options),
		registerTool: () => {},
		getThinkingLevel: () => "off",
		getActiveTools: () => ["session_recall"],
	};
	const rig: Rig = { calls: [], notes: [], behavior: [], ctx: undefined!, fire: undefined!, command: undefined!, completions: undefined!, turnEnd: undefined! };
	let tokens = 0;

	const ctx = {
		cwd,
		hasUI: true,
		signal: undefined,
		model: MODEL,
		isProjectTrusted: () => false,
		getContextUsage: () => ({ tokens, contextWindow: WINDOW, percent: (100 * tokens) / WINDOW }),
		ui: { notify: (msg: string) => rig.notes.push(msg), setWorkingMessage: () => {}, select: async () => undefined },
		sessionManager: { getSessionFile: () => undefined },
		modelRegistry: {
			getAvailable: () => [MODEL],
			find: () => undefined,
			hasConfiguredAuth: () => true,
			streamSimple: (_model: unknown, _context: unknown, options: { signal?: AbortSignal }) => {
				const call: Call = { signal: options.signal };
				rig.calls.push(call);
				const behavior = rig.behavior.shift() ?? "ok";
				const text = `STATE-${rig.calls.length}`;
				const reply = (t: string) => ({ stopReason: "stop", content: [{ type: "text", text: t }], usage: USAGE });
				return {
					result: () => {
						if (behavior === "ok") return Promise.resolve(reply(text));
						if (typeof behavior === "object") return Promise.resolve({ stopReason: "error", errorMessage: behavior.fail, content: [], usage: USAGE });
						return new Promise((resolve) => {
							call.resolve = (t) => resolve(reply(t));
							options.signal?.addEventListener("abort", () => resolve({ stopReason: "aborted", content: [], usage: USAGE }), { once: true });
						});
					},
				};
			},
		},
	};

	rig.ctx = ctx;
	extension(pi as never);
	rig.fire = async (event, payload = {}) => {
		let result: unknown;
		for (const handler of handlers.get(event) ?? []) result = (await handler({ type: event, ...payload }, ctx)) ?? result;
		return result;
	};
	rig.command = (args) => command.handler(args, ctx);
	rig.completions = (prefix) => (command.getArgumentCompletions(prefix) ?? []).map((item: { value: string }) => item.value);
	rig.turnEnd = (entries, t, extra = {}) => {
		tokens = t;
		return rig.fire("turn_end", { outcome: "completed", toolResults: [{}], entries: [], context: { contextEntries: entries }, ...extra });
	};
	return rig;
}

const compactionOf = (result: any) => result?.entries?.find((e: any) => e.type === "compaction");
const discardedOf = (result: any) => (result?.entries ?? []).filter((e: any) => e.customType === "auto-compact-discarded");

// ---------------------------------------------------------------------------------------------------
// precompute off: the behavior of before

test("precompute off (default): nothing starts below the trigger; above it the checkpoint is built synchronously", async () => {
	const rig = setup();
	const entries = history(44);

	assert.equal(await rig.turnEnd(entries, 36_000), undefined);
	assert.equal(rig.calls.length, 0);
	assert.equal(await rig.turnEnd(entries, 40_000), undefined); // not above the threshold yet
	assert.equal(rig.calls.length, 0);

	const result = await rig.turnEnd(entries, 41_000);
	assert.equal(rig.calls.length, 1);
	const compaction = compactionOf(result);
	assert.equal(compaction.firstKeptEntryId, expectedCut(entries));
	assert.match(compaction.summary, /STATE-1/);
	assert.match(compaction.summary, /MSG-22 /); // newest user message of the span, kept whole in the record
	assert.deepEqual(compaction.usage, USAGE);
	assert.equal(discardedOf(result).length, 0);
	assert.equal(result.entries.length, 1);
	assert.ok(rig.notes.some((n) => /compacting without stopping the agent/.test(n)));
	assert.ok(!rig.notes.some((n) => /prepared in/.test(n)));
});

test("precompute off: the loop guard holds after a compaction", async () => {
	const rig = setup();
	const entries = history(44);
	assert.ok(compactionOf(await rig.turnEnd(entries, 41_000)));
	assert.equal(await rig.turnEnd(entries, 42_000), undefined); // first response after: the baseline
	assert.equal(await rig.turnEnd(entries, 48_000), undefined); // not grown by 10k yet
	assert.ok(compactionOf(await rig.turnEnd(entries, 52_000)));
	assert.equal(rig.calls.length, 2);
});

// ---------------------------------------------------------------------------------------------------
// precompute on

test("precompute on: a job starts inside the lead window and the ready state is adopted without a model call", async () => {
	const rig = setup({ precompute: true });
	const early = history(40);

	assert.equal(await rig.turnEnd(early, 35_000), undefined); // exactly compactAt - lead: not yet
	assert.equal(rig.calls.length, 0);
	assert.equal(await rig.turnEnd(early, 36_000), undefined);
	assert.equal(rig.calls.length, 1); // started, not awaited
	await settle();

	const later = history(48);
	const result = await rig.turnEnd(later, 41_000);
	assert.equal(rig.calls.length, 1); // no new call at the trigger
	const compaction = compactionOf(result);
	assert.match(compaction.summary, /STATE-1/);
	assert.match(compaction.summary, /MSG-22 /); // the record holds the messages of the snapshot (span e0..e23)
	assert.doesNotMatch(compaction.summary, /MSG-26 /); // not those of a fresh span (e0..e27)
	assert.deepEqual(compaction.usage, USAGE);
	// the span was planned ahead with a smaller tail than the one planned at the trigger
	assert.equal(compaction.firstKeptEntryId, expectedCut(early, AHEAD_KEEP));
	assert.notEqual(compaction.firstKeptEntryId, expectedCut(later));
	assert.ok(rig.notes.some((n) => /prepared in .* no wait/.test(n)), rig.notes.join("\n"));
	assert.equal(discardedOf(result).length, 0);
});

test("precompute on: no second job while one is busy, none while awaiting the baseline", async () => {
	const rig = setup({ precompute: true });
	const entries = history(40);
	await rig.turnEnd(entries, 36_000);
	await rig.turnEnd(entries, 37_000);
	assert.equal(rig.calls.length, 1);
	await settle();
	assert.ok(compactionOf(await rig.turnEnd(history(44), 41_000)));
	assert.equal(await rig.turnEnd(history(44), 20_000), undefined); // awaiting baseline: no job
	assert.equal(rig.calls.length, 1);
});

test("precompute on: a job still running at the trigger is awaited, then adopted", async () => {
	const rig = setup({ precompute: true });
	rig.behavior.push("manual");
	const early = history(40);
	await rig.turnEnd(early, 36_000);
	assert.equal(rig.calls.length, 1);

	let done = false;
	const pending = rig.turnEnd(history(44), 41_000).then((result) => {
		done = true;
		return result;
	});
	await settle();
	assert.equal(done, false); // waiting for the job
	const realNow = Date.now;
	Date.now = () => realNow() + 3_000; // the job took "3 seconds" more than the wait started
	let result: any;
	try {
		rig.calls[0].resolve?.("LATE-STATE");
		result = await pending;
	} finally {
		Date.now = realNow;
	}
	assert.equal(rig.calls.length, 1);
	assert.match(compactionOf(result).summary, /LATE-STATE/);
	assert.equal(compactionOf(result).firstKeptEntryId, expectedCut(early, AHEAD_KEEP));
	assert.ok(rig.notes.some((n) => /prepared in .* waited 3\.0s/.test(n)), rig.notes.join("\n"));
});

test("an invalidation during the wait sends the compaction down the synchronous path", async () => {
	const rig = setup({ precompute: true });
	rig.behavior.push("manual");
	await rig.turnEnd(history(40), 36_000);
	const entries = history(44);
	const pending = rig.turnEnd(entries, 41_000);
	await settle();
	await rig.fire("model_select"); // aborts the job while the turn_end handler waits for it
	const result = await pending;
	assert.equal(rig.calls.length, 2);
	assert.equal(compactionOf(result).firstKeptEntryId, expectedCut(entries));
	assert.match(compactionOf(result).summary, /STATE-2/);
});
test("the snapshot is validated again after the wait", async () => {
	const rig = setup({ precompute: true });
	rig.behavior.push("manual");
	await rig.turnEnd(history(40), 36_000);
	const entries = history(44);
	const pending = rig.turnEnd(entries, 41_000);
	await settle();
	rig.ctx.model = { ...MODEL, id: "other" }; // changed without any event: only the validation can notice
	rig.calls[0].resolve?.("LATE-STATE");
	const result = await pending;
	assert.equal(rig.calls.length, 2);
	assert.match(compactionOf(result).summary, /STATE-2/);
	const [draft] = discardedOf(result);
	assert.match(draft.data.reason, /settings changed/);
	assert.deepEqual(draft.data.usage, USAGE);
	assert.ok(rig.notes.some((n) => /background summary was discarded/.test(n)));
});

test("precompute on: a failed job falls back to the synchronous path", async () => {
	const rig = setup({ precompute: true });
	rig.behavior.push({ fail: "boom" }, { fail: "boom" }); // the job: first attempt and its retry
	await rig.turnEnd(history(40), 36_000);
	await settle();
	assert.equal(rig.calls.length, 2);

	const entries = history(44);
	const result = await rig.turnEnd(entries, 41_000);
	assert.equal(rig.calls.length, 3);
	assert.equal(compactionOf(result).firstKeptEntryId, expectedCut(entries));
	assert.match(compactionOf(result).summary, /STATE-3/);
});

// ---------------------------------------------------------------------------------------------------
// invalidation

/** A ready snapshot (planned at 36k with 40 entries) and the rig around it. */
async function ready() {
	const rig = setup({ precompute: true });
	await rig.turnEnd(history(40), 36_000);
	await settle();
	assert.equal(rig.calls.length, 1);
	return rig;
}

test("a context_edit on the compacted entries invalidates the snapshot: synchronous path and a discarded draft", async () => {
	const rig = await ready();
	const edited = history(44);
	edited[1] = entryAt(1, "edited");

	const result = await rig.turnEnd(edited, 41_000);
	assert.equal(rig.calls.length, 2);
	assert.equal(compactionOf(result).firstKeptEntryId, expectedCut(edited));
	assert.match(compactionOf(result).summary, /STATE-2/);
	const [draft] = discardedOf(result);
	assert.equal(draft.type, "custom");
	assert.match(draft.data.reason, /edited/);
	assert.equal(draft.data.model, "p/m");
	assert.deepEqual(draft.data.usage, USAGE);
});

test("a changed branch (different entry ids in the span) invalidates the snapshot", async () => {
	const rig = await ready();
	const other = history(44);
	other[10] = { sourceEntry: { id: "other", type: "message" }, messages: other[10].messages } as unknown as ProjectedSessionEntry;
	const result = await rig.turnEnd(other, 41_000);
	assert.equal(rig.calls.length, 2);
	assert.match(discardedOf(result)[0].data.reason, /branch changed/);
});

test("session_compact discards the job; its usage is recorded at the next turn_end", async () => {
	const rig = await ready();
	await rig.fire("session_compact");
	const result = await rig.turnEnd(history(44), 20_000); // awaiting the new baseline
	assert.equal(compactionOf(result), undefined);
	const [draft] = discardedOf(result);
	assert.equal(draft.data.reason, "a compaction happened");
	assert.deepEqual(draft.data.usage, USAGE);
	assert.equal(rig.calls.length, 1);
	assert.equal(discardedOf(await rig.turnEnd(history(44), 21_000)).length, 0); // drained once
});

test("model_select, session_tree and session_before_compact discard the snapshot", async () => {
	for (const [event, reason] of [
		["model_select", /model/],
		["session_tree", /tree/],
		["session_before_compact", /pi compaction/],
	] as const) {
		const rig = await ready();
		await rig.fire(event, { preparation: { messagesToSummarize: [], turnPrefixMessages: [] }, branchEntries: [] });
		const result = await rig.turnEnd(history(44), 41_000);
		assert.equal(rig.calls.length, 2, event); // synchronous path
		assert.ok(compactionOf(result), event);
		assert.match(discardedOf(result)[0].data.reason, reason, event);
	}
});

test("thinking_level_select discards only when the summaries follow the session thinking", async () => {
	const fixed = await ready();
	await fixed.fire("thinking_level_select", { level: "high", previousLevel: "off" });
	assert.equal(discardedOf(await fixed.turnEnd(history(44), 41_000)).length, 0);
	assert.equal(fixed.calls.length, 1); // snapshot still adopted

	const rig = setup({ precompute: true, thinking: "session" });
	await rig.turnEnd(history(40), 36_000);
	await settle();
	await rig.fire("thinking_level_select", { level: "high", previousLevel: "off" });
	const result = await rig.turnEnd(history(44), 41_000);
	assert.equal(rig.calls.length, 2);
	assert.match(discardedOf(result)[0].data.reason, /thinking/);
});

test("session_shutdown aborts a running job", async () => {
	const rig = setup({ precompute: true });
	rig.behavior.push("manual");
	await rig.turnEnd(history(40), 36_000);
	const [call] = rig.calls;
	assert.equal(call.signal?.aborted, false);
	await rig.fire("session_shutdown", { reason: "quit" });
	assert.equal(call.signal?.aborted, true);
	await settle(); // the aborted call settles without an unhandled rejection
});

test("each settings command discards the snapshot on its own", async () => {
	for (const args of ["off", "10", "think high", "model default", "precompute off"]) {
		const rig = await ready();
		await rig.command(args); // one command only: whatever it does, the ready snapshot must be gone
		await rig.command("precompute on"); // does not discard by itself
		await rig.command("status");
		assert.match(rig.notes.at(-1) ?? "", /precompute on \(idle; last dropped/, args);
	}
});

test("a job whose snapshot is already invalid is not waited for", async () => {
	const rig = setup({ precompute: true });
	rig.behavior.push("manual"); // the job never answers by itself
	await rig.turnEnd(history(40), 36_000);
	assert.equal(rig.calls.length, 1);
	const edited = history(44);
	edited[1] = entryAt(1, "edited");
	const result = await rig.turnEnd(edited, 41_000); // would hang if it waited for the job
	assert.ok(compactionOf(result));
	assert.equal(rig.calls[0].signal?.aborted, true);
	assert.equal(rig.calls.length, 2);
	assert.equal(compactionOf(result).firstKeptEntryId, expectedCut(edited));
});

test("one big turn after the snapshot was prepared does not waste it", async () => {
	const rig = await ready(); // snapshot of history(40), keeping AHEAD_KEEP verbatim
	const result = await rig.turnEnd(history(52), 53_000); // the kept tail grew past keepRecent + lead
	assert.equal(rig.calls.length, 1); // no new model call
	assert.equal(compactionOf(result).firstKeptEntryId, expectedCut(history(40), AHEAD_KEEP));
});

test("a compaction resets the job budget and the pause", async () => {
	const rig = setup({ precompute: true });
	rig.behavior.push({ fail: "boom" }, { fail: "boom" }, { fail: "boom" }, { fail: "boom" }); // two failed jobs (two attempts each)
	await rig.turnEnd(history(40), 36_000);
	await settle();
	await rig.turnEnd(history(40), 37_000);
	await settle();
	assert.equal(rig.calls.length, 4);
	await rig.turnEnd(history(40), 38_000);
	assert.equal(rig.calls.length, 4); // paused after two failures

	assert.ok(compactionOf(await rig.turnEnd(history(44), 41_000))); // synchronous: call 5
	assert.equal(rig.calls.length, 5);
	await rig.turnEnd(history(44), 20_000); // the baseline
	await rig.turnEnd(history(44), 36_000);
	assert.equal(rig.calls.length, 6); // a job starts again: the pause was lifted by the compaction
});

// ---------------------------------------------------------------------------------------------------
// resume, command

test("resume: a text-only turn right after an adopted compaction asks the agent to continue", async () => {
	const rig = await ready();
	assert.ok(compactionOf(await rig.turnEnd(history(44), 41_000)));
	await rig.turnEnd(history(44), 20_000, { toolResults: [] }); // text-only turn
	const reply = { role: "assistant", content: [{ type: "text", text: "Read f3.txt." }] };
	const result = await rig.fire("agent_before_settle", { outcome: "completed", entries: [], context: { contextMessages: [reply] } });
	assert.equal(result.continue, true);
	assert.equal(result.entries[0].customType, "auto-compact-resume");
});

test("/autocompact precompute on|off persists, shows in status and completes", async () => {
	const rig = setup({ minTokens: 5_000 });
	const stored = () => JSON.parse(readFileSync(configFile, "utf8"));

	await rig.command("status");
	assert.match(rig.notes.at(-1) ?? "", /precompute off/);
	await rig.command("precompute on");
	assert.equal(stored().precompute, true);
	assert.equal(stored().minTokens, 5_000); // other keys preserved
	assert.match(rig.notes.at(-1) ?? "", /precompute on \(idle\)/);
	await rig.turnEnd(history(40), 36_000);
	assert.equal(rig.calls.length, 1);
	await settle();
	await rig.command("status");
	assert.match(rig.notes.at(-1) ?? "", /precompute on \(ready\)/);

	await rig.command("precompute off");
	assert.equal(stored().precompute, false);
	assert.match(rig.notes.at(-1) ?? "", /precompute off/);
	await rig.command("precompute sideways");
	assert.match(rig.notes.at(-1) ?? "", /Usage/);
	assert.equal(stored().precompute, false);

	assert.ok(rig.completions("pre").includes("precompute"));
	assert.deepEqual(rig.completions("precompute o"), ["precompute on", "precompute off"]);
	assert.ok(rig.completions("").includes("precompute"));
});

mkdirSync(agentDir, { recursive: true });
