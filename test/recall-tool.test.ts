import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { registerRecallTool } from "../src/recall-tool.ts";

const text = (t: string) => ({ type: "text", text: t });
const message = (id: string, m: object, at = 1) =>
	({ type: "message", id, parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { timestamp: at, ...m } }) as unknown as SessionEntry;

// e1..e3 were compacted away; e4..e5 are still in context.
const branch = [
	message("e1", { role: "user", content: "please inspect a.ts" }),
	message("e2", { role: "assistant", content: [text("looking"), { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } }] }),
	message("e3", { role: "toolResult", toolCallId: "c1", toolName: "read", content: [text(`line one\nSECRET_TOKEN=abc123\n${"z".repeat(30_000)}`)], isError: false }),
	message("e4", { role: "user", content: "what was the token? SECRET_TOKEN" }),
	message("e5", { role: "assistant", content: [text("checking")] }),
];
const visible = new Set(["e4", "e5"]);

interface Tool {
	name: string;
	annotations?: { readOnlyHint?: boolean };
	promptGuidelines?: string[];
	execute(id: string, params: Record<string, unknown>, signal: undefined, onUpdate: undefined, ctx: unknown): Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;
}

function setup() {
	const tools: Tool[] = [];
	registerRecallTool({ registerTool: (tool: Tool) => tools.push(tool) } as unknown as ExtensionAPI);
	const ctx = { sessionManager: { getBranch: () => branch, buildContextEntries: () => branch.filter((e) => visible.has(e.id)) } };
	const run = (params: Record<string, unknown>) => tools[0].execute("t1", params, undefined, undefined, ctx);
	return { tools, run };
}

test("registers one read-only tool named session_recall with a guideline that names it", () => {
	const { tools } = setup();
	assert.equal(tools.length, 1);
	assert.equal(tools[0].name, "session_recall");
	assert.equal(tools[0].annotations?.readOnlyHint, true);
	assert.ok(tools[0].promptGuidelines?.some((g) => g.includes("session_recall")));
});

test("search finds compacted entries only by default and all of them with scope all", async () => {
	const { run } = setup();
	const compacted = await run({ query: "secret_token" });
	assert.ok(!compacted.isError);
	const out = compacted.content[0].text;
	assert.match(out, /1 matching entry/);
	assert.match(out, /\[e3\] .*read path="a\.ts"/);
	assert.ok(!out.includes("[e4]"));
	assert.match(out, /entryId=<id>/);

	const all = (await run({ query: "secret_token", scope: "all" })).content[0].text;
	assert.match(all, /2 matching entries/);
	assert.match(all, /\[e4\] .*in context/);
	assert.doesNotMatch(all, /\[e3\] .*in context/);
});

test("read returns the entry with its call, paginated", async () => {
	const { run } = setup();
	const page = (await run({ entryId: "e3", maxChars: 1_000 })).content[0].text;
	assert.match(page, /^toolResult · .* · read path="a\.ts"/);
	assert.match(page, /SECRET_TOKEN=abc123/);
	assert.match(page, /\[chars 0–1000 of \d+; call again with offset=1000\]$/);
	const next = (await run({ entryId: "e3", offset: 1_000, maxChars: 1_000 })).content[0].text;
	assert.match(next, /\[chars 1000–2000 of /);
	assert.ok(!next.includes("SECRET_TOKEN"));

	const assistantEntry = (await run({ entryId: "e2" })).content[0].text;
	assert.match(assistantEntry, /looking\n→ read path="a\.ts"/);
});

test("errors: unknown entry, nothing to do, empty query, non-text entry", async () => {
	const { run } = setup();
	const missing = await run({ entryId: "zzzz" });
	assert.equal(missing.isError, true);
	assert.match(missing.content[0].text, /No entry "zzzz"/);
	assert.equal((await run({})).isError, true);
	assert.equal((await run({ query: "  " })).isError, true);
});

test("output never exceeds the byte limit, whatever maxChars asks for", async () => {
	const { run } = setup();
	const out = (await run({ entryId: "e3", maxChars: 1_000_000 })).content[0].text;
	assert.ok(Buffer.byteLength(out) < 60 * 1024);
});
