import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildToolCallIndex, entryText, renderEntryPage, renderHits, searchEntries } from "../src/recall.ts";

const text = (t: string) => ({ type: "text", text: t });
const call = (name: string, args: object, id = "c1") => ({ type: "toolCall", id, name, arguments: args });
const message = (id: string, m: object, at = 1) =>
	({ type: "message", id, parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { timestamp: at, ...m } }) as unknown as SessionEntry;
const user = (id: string, t: string, at?: number) => message(id, { role: "user", content: t }, at);
const assistant = (id: string, content: object[], at?: number) => message(id, { role: "assistant", content }, at);
const result = (id: string, callId: string, t: string, isError = false, at?: number) =>
	message(id, { role: "toolResult", toolCallId: callId, toolName: "read", content: [text(t)], isError }, at);
const compaction = (id: string) =>
	({ type: "compaction", id, parentId: null, timestamp: "2026-01-01T00:00:00.000Z", summary: "needle in the summary", firstKeptEntryId: "x", tokensBefore: 1 }) as unknown as SessionEntry;

const none = new Set<string>();
const index = (entries: SessionEntry[]) => buildToolCallIndex(entries);

test("search covers only entries missing from the context by default", () => {
	const entries = [user("e1", "needle one"), user("e2", "needle two"), user("e3", "needle three")];
	const found = searchEntries(entries, new Set(["e3"]), { query: "needle" });
	assert.ok(typeof found !== "string");
	assert.deepEqual(found.hits.map((h) => h.id), ["e2", "e1"]);
	assert.ok(found.hits.every((h) => !h.inContext));
});

test("scope all includes entries in context and marks them", () => {
	const entries = [user("e1", "needle one"), user("e2", "needle two")];
	const found = searchEntries(entries, new Set(["e2"]), { query: "needle", scope: "all" });
	assert.ok(typeof found !== "string");
	assert.deepEqual(found.hits.map((h) => [h.id, h.inContext]), [["e2", true], ["e1", false]]);
	assert.match(renderHits(found.hits, found.total, "all"), /\[e2\] .*in context/);
	assert.doesNotMatch(renderHits(found.hits, found.total, "all"), /\[e1\] .*in context/);
});

test("results come newest first, limited, with the total of matching entries", () => {
	const entries = Array.from({ length: 5 }, (_, i) => user(`e${i}`, `needle ${i}`));
	const found = searchEntries(entries, none, { query: "needle", limit: 2 });
	assert.ok(typeof found !== "string");
	assert.deepEqual(found.hits.map((h) => h.id), ["e4", "e3"]);
	assert.equal(found.total, 5);
	assert.match(renderHits(found.hits, found.total), /showing the 2 newest of 5/);
	// limit is clamped to 1..50
	const clamped = searchEntries(entries, none, { query: "needle", limit: 0 });
	assert.ok(typeof clamped !== "string");
	assert.equal(clamped.hits.length, 1);
});

test("search is case-insensitive, literal (no regex) and counts the matches per entry", () => {
	const entries = [user("e1", "Error: NEEDLE and needle"), user("e2", "a.*b"), user("e3", "axxb")];
	const found = searchEntries(entries, none, { query: "needle" });
	assert.ok(typeof found !== "string");
	assert.equal(found.hits[0].matches, 2);
	const literal = searchEntries(entries, none, { query: "a.*b" });
	assert.ok(typeof literal !== "string");
	assert.deepEqual(literal.hits.map((h) => h.id), ["e2"]);
});

test("a tool result matches on the signature of the call it answers", () => {
	const entries = [
		assistant("e1", [call("read", { path: "a.ts" }, "c1")]),
		result("e2", "c1", "export const x = 1", false),
		assistant("e3", [call("read", { path: "b.ts" }, "c2")]),
		result("e4", "c2", "other", true),
	];
	const found = searchEntries(entries, none, { query: 'path="a.ts"' });
	assert.ok(typeof found !== "string");
	// the call line in the assistant entry and the result both carry the signature
	assert.deepEqual(found.hits.map((h) => h.id), ["e2", "e1"]);
	assert.equal(found.hits[0].label, 'read path="a.ts"');
	assert.equal(entryText(entries[3], index(entries))?.label, 'read path="b.ts" ✗');
});

test("snippets show about 150 chars around the first match, with ellipses at cut edges", () => {
	const body = `${"a".repeat(400)} NEEDLE ${"b".repeat(400)}`;
	const found = searchEntries([user("e1", body), user("e2", "needle")], none, { query: "needle" });
	assert.ok(typeof found !== "string");
	const long = found.hits.find((h) => h.id === "e1");
	assert.ok(long);
	assert.ok(long.snippet.startsWith("…") && long.snippet.endsWith("…"));
	assert.ok(long.snippet.length < 330);
	assert.ok(long.snippet.includes("NEEDLE"));
	assert.equal(found.hits.find((h) => h.id === "e2")?.snippet, "user needle");
});

test("empty or blank queries return an error message", () => {
	assert.equal(typeof searchEntries([user("e1", "x")], none, { query: "" }), "string");
	assert.match(searchEntries([user("e1", "x")], none, { query: "   " }) as string, /empty/);
});

test("entryText: images become [image], reasoning is excluded, tool calls get a signature line", () => {
	const entries = [
		message("e1", { role: "user", content: [text("look"), { type: "image", data: "xx", mimeType: "image/png" }] }),
		assistant("e2", [{ type: "thinking", thinking: "secret plan" }, text("reading"), call("read", { path: "a.ts" })]),
		message("e3", { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "image", data: "xx", mimeType: "image/png" }], isError: false }),
	];
	const idx = index(entries);
	assert.equal(entryText(entries[0], idx)?.text, "look\n[image]");
	const assistantText = entryText(entries[1], idx);
	assert.equal(assistantText?.text, 'reading\n→ read path="a.ts"');
	assert.ok(!assistantText?.text.includes("secret"));
	assert.equal(entryText(entries[2], idx)?.text, "[image]");
	const found = searchEntries(entries, none, { query: "secret" });
	assert.ok(typeof found !== "string");
	assert.equal(found.total, 0);
});

test("compaction and other non-conversation entries are never returned", () => {
	const entries = [compaction("c0"), { type: "model_change", id: "m1", parentId: null, timestamp: "t", provider: "p", modelId: "needle" } as unknown as SessionEntry];
	assert.equal(entryText(entries[0], index(entries)), undefined);
	assert.equal(entryText(entries[1], index(entries)), undefined);
	const found = searchEntries(entries, none, { query: "needle", scope: "all" });
	assert.ok(typeof found !== "string");
	assert.equal(found.total, 0);
	assert.match(renderHits(found.hits, found.total, "all"), /No matches/);
});

test("custom messages are readable; bash runs hidden from the context are not", () => {
	const custom = { type: "custom_message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", customType: "note", content: "remember this", display: true } as unknown as SessionEntry;
	assert.deepEqual(entryText(custom, new Map()), { kind: "custom", label: "note", at: Date.parse("2026-01-01T00:00:00.000Z"), text: "remember this" });
	const bash = (excludeFromContext: boolean) => message("b1", { role: "bashExecution", command: "ls", output: "files", exitCode: 0, cancelled: false, truncated: false, excludeFromContext });
	assert.equal(entryText(bash(false), new Map())?.text, "files");
	assert.equal(entryText(bash(true), new Map()), undefined);
});

test("renderEntryPage paginates with a footer that names the next offset", () => {
	const content = { kind: "toolResult" as const, label: 'read path="a.ts"', at: 0, text: "x".repeat(2_500) };
	const first = renderEntryPage(content, 0, 1_000);
	assert.match(first, /\[chars 0–1000 of 2500; call again with offset=1000\]$/);
	assert.match(first, /^toolResult · 1970-01-01 00:00Z · read path="a\.ts"/);
	const last = renderEntryPage(content, 2_000, 1_000);
	assert.match(last, /\[chars 2000–2500 of 2500; end of entry\]$/);
	assert.ok(last.includes("x".repeat(500)) && !last.includes("x".repeat(501)));
	assert.match(renderEntryPage(content, 9_999, 1_000), /past the end: the entry has 2500 chars/);
});

test("renderEntryPage defaults to 12k chars and clamps maxChars to 1k..40k", () => {
	const content = { kind: "user" as const, label: "user", at: 0, text: "y".repeat(100_000) };
	assert.match(renderEntryPage(content), /\[chars 0–12000 of 100000; call again with offset=12000\]$/);
	assert.match(renderEntryPage(content, 0, 5), /\[chars 0–1000 of/);
	assert.match(renderEntryPage(content, 0, 1_000_000), /\[chars 0–40000 of/);
	assert.match(renderEntryPage(content, -5, Number.NaN), /\[chars 0–12000 of/);
});
