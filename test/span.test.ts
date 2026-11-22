import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";
import { extractFacts, planSpan, toolSignature } from "../src/span.ts";

const user = (text: string, timestamp = 1): AgentMessage => ({ role: "user", content: text, timestamp });
const assistant = (...content: object[]): AgentMessage =>
	({ role: "assistant", content, timestamp: 1 }) as unknown as AgentMessage;
const text = (t: string) => ({ type: "text", text: t });
const call = (name: string, args: object, id = "x") => ({ type: "toolCall", id, name, arguments: args });
const result = (t: string, id = "x", isError = false): AgentMessage =>
	({ role: "toolResult", toolCallId: id, toolName: "x", content: [text(t)], isError, timestamp: 1 }) as unknown as AgentMessage;

const entry = (id: string, type: string, ...messages: AgentMessage[]) =>
	({ sourceEntry: { id, type }, messages }) as unknown as ProjectedSessionEntry;
const message = (id: string, m: AgentMessage) => entry(id, "message", m);

const hundred = () => 100;

// e0 user, e1 assistant(tool call), e2 toolResult, e3 assistant(tool call), e4 toolResult, e5 assistant
const history = () => [
	message("e0", user("first")),
	message("e1", assistant(call("read", { path: "a.ts" }))),
	message("e2", result("a")),
	message("e3", assistant(call("bash", { command: "ls" }))),
	message("e4", result("b")),
	message("e5", assistant(text("done"))),
];

test("planSpan keeps ~keepRecentTokens and summarizes the rest", () => {
	const span = planSpan(history(), 250, hundred);
	assert.equal(span?.firstKeptEntryId, "e3");
	assert.deepEqual(span?.messages.map((m) => m.role), ["user", "assistant", "toolResult"]);
	assert.equal(span?.previous, undefined);
});

test("planSpan never cuts at a tool result", () => {
	// The budget is reached exactly at e2 (a tool result): the cut moves forward to e3.
	const span = planSpan(history(), 350, hundred);
	assert.equal(span?.firstKeptEntryId, "e3");
});

test("planSpan returns undefined when everything fits in the kept budget", () => {
	assert.equal(planSpan(history(), 10_000, hundred), undefined);
	assert.equal(planSpan([], 100, hundred), undefined);
});

test("planSpan starts after the latest compaction and reports it as previous", () => {
	const summary = { role: "compactionSummary", summary: "old", tokensBefore: 1, timestamp: 1 } as unknown as AgentMessage;
	const compaction = entry("c0", "compaction", summary);
	const entries = [compaction, message("k1", user("kept user")), message("k2", assistant(text("kept"))), ...history().slice(3)];
	const span = planSpan(entries, 250, hundred);
	assert.equal(span?.previous?.id, "c0");
	// the compaction summary itself is not re-summarized
	assert.ok(span?.messages.every((m) => m.role !== "compactionSummary"));
	assert.equal(span?.messages[0].role, "user");
});

test("planSpan ignores entries without model-visible messages", () => {
	const entries = [entry("meta", "model_change"), ...history()];
	assert.equal(planSpan(entries, 250, hundred)?.firstKeptEntryId, "e3");
});

test("extractFacts records user text, assistant prose and tool signatures in order", () => {
	const messages: AgentMessage[] = [
		user("do   the thing", 42),
		assistant(
			{ type: "thinking", thinking: "secret reasoning" },
			text("Looking at it."),
			text("Two parts."),
			call("read", { path: "a.ts" }, "c1"),
			text("Now the edit."),
			call("edit", { path: "b.ts" }, "c2"),
		),
		result("ignored output", "c1"),
		result("ignored output", "c2"),
		{ role: "user", content: [text("see image"), { type: "image", data: "", mimeType: "image/png" }], timestamp: 43 } as AgentMessage,
	];
	const { events } = extractFacts(messages);
	assert.deepEqual(events, [
		{ k: "u", at: 42, text: "do   the thing" },
		{ k: "a", at: 1, text: "Looking at it.\nTwo parts." },
		{ k: "t", sig: 'read path="a.ts"' },
		{ k: "a", at: 1, text: "Now the edit." },
		{ k: "t", sig: 'edit path="b.ts"' },
		{ k: "u", at: 43, text: "see image\n[image]" },
	]);
	assert.ok(!JSON.stringify(events).includes("secret reasoning"));
	assert.ok(!JSON.stringify(events).includes("ignored output"));
});

test("extractFacts lists files from successful read/edit/write calls only", () => {
	const { readFiles, modifiedFiles, events } = extractFacts([
		assistant(
			call("read", { path: "a.ts" }, "r1"),
			call("read", { path: "missing.ts" }, "r2"),
			call("edit", { path: "b.ts" }, "e1"),
			call("edit", { path: "failed.ts" }, "e2"),
			call("write", { path: "c.ts" }, "w1"),
			call("grep", { path: "ignored.ts" }, "g1"),
		),
		result("ok", "r1"),
		result("ENOENT", "r2", true),
		result("ok", "e1"),
		result("no match", "e2", true),
		result("ok", "w1"),
		result("ok", "g1"),
	]);
	assert.deepEqual(readFiles, ["a.ts"]);
	assert.deepEqual(modifiedFiles, ["b.ts", "c.ts"]);
	// failed calls stay in the record, marked
	assert.deepEqual(
		events.map((e) => (e.k === "t" ? e.sig : "")),
		['read path="a.ts"', 'read path="missing.ts" ✗', 'edit path="b.ts"', 'edit path="failed.ts" ✗', 'write path="c.ts"', 'grep path="ignored.ts"'],
	);
});

test("extractFacts skips empty messages", () => {
	assert.deepEqual(extractFacts([user("   "), assistant(text("  "))]).events, []);
});

test("toolSignature puts the key arguments first, collapses whitespace and truncates", () => {
	assert.equal(toolSignature("bash", { timeout: 5, command: "git  status\n --short" }, false), 'bash command="git status --short" timeout=5');
	assert.equal(toolSignature("read", { offset: 1, limit: null, path: "a.ts" }, false), 'read path="a.ts" offset=1');
	const long = toolSignature("bash", { command: "x".repeat(500) }, false);
	assert.ok(long.length <= 221);
	assert.ok(long.includes("…"));
	assert.equal(toolSignature("edit", { path: "a.ts", edits: [{ oldText: "a", newText: "b" }] }, false), 'edit path="a.ts" edits=[{"oldText":"a","newText":"b"}]');
	assert.ok(toolSignature("bash", { command: "y".repeat(500) }, true).endsWith(" ✗"));
	assert.equal(toolSignature("todo", {}, false), "todo");
});
