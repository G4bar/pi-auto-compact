import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { CompactionEntry, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assembleCheckpoint, buildCheckpoint, generateStateWithRetry, settingsKey } from "../src/summarize.ts";

const model = (provider: string, id: string, extra: object = {}) =>
	({ provider, id, contextWindow: 1_000_000, maxTokens: 64_000, reasoning: false, ...extra }) as unknown as Model<Api>;
const active = model("anthropic", "sonnet");
const cheap = model("anthropic", "haiku");

const USAGE = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const reply = (text: string) => ({ stopReason: "stop", content: [{ type: "text", text }], usage: USAGE });
const failure = (errorMessage: string) => ({ stopReason: "error", errorMessage, content: [], usage: USAGE });

type Scripted = ReturnType<typeof reply> | ReturnType<typeof failure>;

/** A context whose `streamSimple(...).result()` pops scripted replies and records the model of each call. */
function fakeCtx(script: Scripted[], opts: { active?: Model<Api>; configured?: Model<Api>; sessionFile?: string } = {}) {
	const calls: string[] = [];
	const ctx = {
		model: opts.active ?? active,
		sessionManager: { getSessionFile: () => opts.sessionFile ?? "/tmp/s.jsonl" },
		modelRegistry: {
			find: (provider: string, id: string) => (opts.configured?.provider === provider && opts.configured.id === id ? opts.configured : undefined),
			hasConfiguredAuth: () => true,
			streamSimple: (m: Model<Api>) => {
				calls.push(`${m.provider}/${m.id}`);
				return { result: async () => script.shift() ?? failure("script exhausted") };
			},
		},
	} as unknown as ExtensionContext;
	return { ctx, calls };
}

const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 1 });
const messages = [user("fix the bug")];
const STATE = "## Goal\nfix the bug";

const previous = (state: string) =>
	({ id: "c0", type: "compaction", summary: "old", details: { readFiles: [], modifiedFiles: [], checkpoint: { v: 2, state, record: [] } } }) as unknown as CompactionEntry;

test("buildCheckpoint equals assembleCheckpoint(generateStateWithRetry(...)) on the same input", async () => {
	const prev = previous("old state");
	const a = fakeCtx([reply(STATE)]);
	const built = await buildCheckpoint({ ctx: a.ctx, messages, previous: prev, recordBudgetChars: 10_000 });

	const b = fakeCtx([reply(STATE)]);
	const generated = await generateStateWithRetry({ ctx: b.ctx, messages, previousState: "old state" });
	const assembled = assembleCheckpoint({ sessionFile: "/tmp/s.jsonl", messages, previous: prev, generated, recordBudgetChars: 10_000 });

	assert.deepEqual(built, assembled);
	assert.equal(generated.state, STATE);
	assert.equal(generated.model, "anthropic/sonnet");
	assert.equal(generated.thinking, "off");
	assert.match(built.summary, /## State summary\n\n## Goal\nfix the bug/);
	assert.deepEqual(built.usage, USAGE);
});

test("a failure with the configured model retries with the active model and sets a note", async () => {
	const { ctx, calls } = fakeCtx([failure("boom"), reply(STATE)], { configured: cheap });
	const generated = await generateStateWithRetry({ ctx, messages, summarizerKey: "anthropic/haiku" });
	assert.deepEqual(calls, ["anthropic/haiku", "anthropic/sonnet"]);
	assert.equal(generated.state, STATE);
	assert.equal(generated.degraded, undefined);
	assert.match(generated.note ?? "", /summary model anthropic\/haiku failed \(boom\); retried with the active model/);
});

test("two failures degrade to the deterministic fallback state", async () => {
	const { ctx, calls } = fakeCtx([failure("first"), failure("second")], { configured: cheap });
	const generated = await generateStateWithRetry({ ctx, messages, previousState: "old state", summarizerKey: "anthropic/haiku" });
	assert.equal(calls.length, 2);
	assert.equal(generated.degraded, "second");
	assert.equal(generated.usage, undefined);
	assert.match(generated.state, /A model-written summary was unavailable.*second/);
	assert.match(generated.state, /### Previous state\n\nold state/);
	assert.match(generated.note ?? "", /first/);
});

test("an abort rejects instead of degrading", async () => {
	const controller = new AbortController();
	const { ctx } = fakeCtx([failure("aborted")]);
	controller.abort();
	await assert.rejects(generateStateWithRetry({ ctx, messages, signal: controller.signal }), /aborted/);
	await assert.rejects(buildCheckpoint({ ctx: fakeCtx([failure("aborted")]).ctx, messages, signal: controller.signal, recordBudgetChars: 1000 }));
});

test("an unavailable configured model preserves its unavailable note when attempt 1 fails", async () => {
	const { ctx, calls } = fakeCtx([failure("boom"), reply(STATE)]);
	const generated = await generateStateWithRetry({ ctx, messages, summarizerKey: "x/gone" });
	assert.deepEqual(calls, ["anthropic/sonnet", "anthropic/sonnet"]);
	assert.equal(generated.state, STATE);
	assert.equal(generated.degraded, undefined);
	assert.match(generated.note ?? "", /summary model x\/gone is unavailable/);
	assert.doesNotMatch(generated.note ?? "", /summary model x\/gone failed/);

	const degradedCtx = fakeCtx([failure("first"), failure("second")]);
	const degraded = await generateStateWithRetry({ ctx: degradedCtx.ctx, messages, summarizerKey: "x/gone" });
	assert.equal(degraded.degraded, "second");
	assert.match(degraded.note ?? "", /summary model x\/gone is unavailable/);
	assert.doesNotMatch(degraded.note ?? "", /summary model x\/gone failed/);
});

test("settingsKey changes with the summary model, thinking level and active model", () => {
	const thinker = model("anthropic", "thinker", { reasoning: true });
	const { ctx } = fakeCtx([], { configured: thinker });
	const base = settingsKey(ctx);
	assert.equal(base, settingsKey(ctx, { sessionThinking: "off" }));
	assert.notEqual(base, settingsKey(ctx, { summarizerKey: "anthropic/thinker", sessionThinking: "off" }));
	// "session" follows the session level, but a non-reasoning model resolves to "off" either way
	assert.equal(settingsKey(ctx, { thinking: "session", sessionThinking: "high" }), base);
	const withThinking = settingsKey(ctx, { summarizerKey: "anthropic/thinker", thinking: "session", sessionThinking: "high" });
	assert.notEqual(withThinking, settingsKey(ctx, { summarizerKey: "anthropic/thinker", thinking: "session", sessionThinking: "low" }));
	assert.notEqual(base, settingsKey(fakeCtx([], { active: cheap }).ctx, { sessionThinking: "off" }));
	// an unknown configured model resolves to the active one, like generation does
	assert.equal(settingsKey(ctx, { summarizerKey: "x/gone", sessionThinking: "off" }), base);
});
