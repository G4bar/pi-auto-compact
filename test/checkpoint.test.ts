import assert from "node:assert/strict";
import { test } from "node:test";
import type { CompactionEntry } from "@earendil-works/pi-coding-agent";
import {
	MAX_STATE_CHARS,
	type RecordItem,
	buildRecord,
	capState,
	elideMiddle,
	mergeFiles,
	readPrevious,
	recordBudgetChars,
	renderCheckpoint,
} from "../src/checkpoint.ts";
import type { RecordEvent } from "../src/span.ts";

const u = (text: string, at = 0): RecordEvent => ({ k: "u", at, text });
const a = (text: string, at = 0): RecordEvent => ({ k: "a", at, text });
const t = (sig: string): RecordEvent => ({ k: "t", sig });
const compaction = (details: unknown, summary = "old summary") => ({ summary, details }) as unknown as CompactionEntry;
const BIG = 1_000_000;

const shape = (items: RecordItem[]) => items.map((i) => (i.k === "t" ? `t:${i.sig}` : `${i.k}:${i.text}`));

test("buildRecord keeps everything verbatim and in order within the budget", () => {
	const record = buildRecord([], [u("hello", 1), a("hi"), t("read path=\"a.ts\""), u("world", 2)], BIG);
	assert.deepEqual(shape(record), ["u:hello", "a:hi", 't:read path="a.ts"', "u:world"]);
	assert.deepEqual(record.filter((i) => i.k === "u").map((i) => i.n), [1, 2]);
});

test("buildRecord continues numbering and keeps previous items", () => {
	const prev = buildRecord([], [u("a"), a("b")], BIG);
	const next = buildRecord(prev, [u("c")], BIG);
	assert.deepEqual(shape(next), ["u:a", "a:b", "u:c"]);
	assert.deepEqual(next.filter((i) => i.k === "u").map((i) => i.n), [1, 2]);
	assert.deepEqual(shape(prev), ["u:a", "a:b"]); // input untouched
});

test("buildRecord elides the middle of very long prose and records the original length", () => {
	const long = `HEAD${"x".repeat(10_000)}TAIL`;
	const [user, assistant] = buildRecord([], [u(long), a(long)], BIG);
	for (const item of [user, assistant]) {
		assert.ok(item.k !== "t");
		assert.ok(item.text.startsWith("HEAD") && item.text.endsWith("TAIL"));
		assert.match(item.text, /\[… \d+ chars omitted …\]/);
		assert.ok(item.text.length < 4_200 && item.len === long.length);
	}
});

test("buildRecord drops tool signatures first, then assistant prose, then user messages, oldest first", () => {
	const events = [
		u("U1".repeat(300)),
		a("A1".repeat(300)),
		t("t1".repeat(50)),
		u("U2".repeat(300)),
		a("A2".repeat(300)),
		t("t2".repeat(50)),
		u("U3".repeat(300)),
		a("A3".repeat(300)),
	];
	// Costs: user 600+48, assistant 600+8, tool 100+3 each => 3974 in total.
	const texts = (items: RecordItem[], k: "u" | "a") => items.flatMap((i) => (i.k === k ? [i.text] : []));
	const sigs = (items: RecordItem[]) => items.flatMap((i) => (i.k === "t" ? [i.sig] : []));
	const intact = (k: "U" | "A") => [1, 2, 3].map((n) => `${k}${n}`.repeat(300));

	// 3800: dropping both signatures (-206) is enough; all prose survives
	const sigsOnly = buildRecord([], events, 3_800);
	assert.deepEqual(sigs(sigsOnly), ["", ""]);
	assert.deepEqual(texts(sigsOnly, "a"), intact("A"));
	assert.deepEqual(texts(sigsOnly, "u"), intact("U"));

	// 2600: the two oldest assistant bodies go as well; the newest one and every user message stay
	const noOldProse = buildRecord([], events, 2_600);
	assert.deepEqual(texts(noOldProse, "a"), ["", "", "A3".repeat(300)]);
	assert.deepEqual(texts(noOldProse, "u"), intact("U"));

	// 1: oldest user bodies go too, with a stub that keeps the original size; the newest user and assistant stay
	const tiny = buildRecord([], events, 1);
	assert.deepEqual(texts(tiny, "u"), ["", "", "U3".repeat(300)]);
	assert.deepEqual(texts(tiny, "a"), ["", "", "A3".repeat(300)]);
	assert.equal(tiny.find((i) => i.k === "u")?.len, 600);
});

test("recordBudgetChars is a quarter of the threshold, within 4k..40k tokens", () => {
	assert.equal(recordBudgetChars(8_000), 4_000 * 4);
	assert.equal(recordBudgetChars(40_000), 10_000 * 4);
	assert.equal(recordBudgetChars(1_000_000), 40_000 * 4);
});

test("elideMiddle is a no-op under the limit", () => {
	assert.equal(elideMiddle("short", 10, 5, 3), "short");
});

test("mergeFiles: modified wins over read, lists are unique and sorted", () => {
	const merged = mergeFiles(
		{ readFiles: ["b.ts", "a.ts"], modifiedFiles: ["m.ts"] },
		{ readFiles: ["m.ts", "c.ts", "a.ts"], modifiedFiles: ["b.ts"] },
	);
	assert.deepEqual(merged.modifiedFiles, ["b.ts", "m.ts"]);
	assert.deepEqual(merged.readFiles, ["a.ts", "c.ts"]);
});

test("capState keeps the newest part of an over-long state", () => {
	assert.equal(capState("ok"), "ok");
	const capped = capState(`${"o".repeat(MAX_STATE_CHARS)}NEWEST`);
	assert.ok(capped.endsWith("NEWEST"));
	assert.ok(capped.startsWith("[… older state omitted …]"));
});

test("readPrevious understands our own checkpoint", () => {
	const carried = { v: 2, state: "S", record: [{ k: "u", n: 1, at: 1, text: "t", len: 1 }, { k: "a", at: 1, text: "x", len: 1 }, { k: "t", sig: "ls" }] };
	const prev = readPrevious(compaction({ readFiles: ["r"], modifiedFiles: ["m"], checkpoint: carried }));
	assert.deepEqual(prev.carried, carried);
	assert.equal(prev.state, "S");
	assert.deepEqual([prev.readFiles, prev.modifiedFiles], [["r"], ["m"]]);
});

test("readPrevious falls back to the whole summary for foreign or older-format compactions", () => {
	const prev = readPrevious(compaction({ readFiles: ["r"], modifiedFiles: [] }, "pi default summary"));
	assert.equal(prev.carried, undefined);
	assert.equal(prev.state, "pi default summary");
	assert.deepEqual(prev.readFiles, ["r"]);
	const v1 = { v: 1, state: "S", pinned: [], commands: [] };
	assert.equal(readPrevious(compaction({ checkpoint: v1 }, "v1 summary")).state, "v1 summary");
});

test("readPrevious tolerates missing and malformed details", () => {
	assert.deepEqual(readPrevious(undefined), { readFiles: [], modifiedFiles: [] });
	assert.equal(readPrevious(compaction(undefined)).state, "old summary");
	assert.equal(readPrevious(compaction({ checkpoint: { v: 2, state: "S", record: [{ k: "z" }] }, readFiles: "nope" })).carried, undefined);
	assert.deepEqual(readPrevious(compaction({ readFiles: "nope" })).readFiles, []);
});

const baseInput = { record: [], state: "## Goal\nship it", readFiles: [], modifiedFiles: [] };

test("renderCheckpoint shows the record in order: user, assistant prose, grouped tool signatures, stubs", () => {
	const record = buildRecord(
		[],
		[u("never touch the migrations folder", Date.UTC(2026, 0, 2, 3, 5)), a("Understood, reading the config."), t('read path="a.ts"'), t('bash command="npm test" ✗')],
		BIG,
	);
	const out = renderCheckpoint({ ...baseInput, record });
	assert.match(out, /## Record \(verbatim, oldest first\)/);
	assert.match(out, /\[U1 · 2026-01-02 03:05Z\]\nnever touch the migrations folder/);
	assert.match(out, /\[A\]\nUnderstood, reading the config\./);
	assert.match(out, /→ read path="a\.ts"\n→ bash command="npm test" ✗/);
	assert.ok(out.indexOf("[U1") < out.indexOf("[A]") && out.indexOf("[A]") < out.indexOf("→ read"));
});

test("renderCheckpoint marks dropped bodies and collapses dropped tool calls", () => {
	const record: RecordItem[] = [
		{ k: "u", n: 1, at: Date.UTC(2026, 0, 2, 3, 4), text: "", len: 777 },
		{ k: "a", at: 0, text: "", len: 55 },
		{ k: "t", sig: "" },
		{ k: "t", sig: "" },
		{ k: "t", sig: "read path=\"kept.ts\"" },
	];
	const out = renderCheckpoint({ ...baseInput, record });
	assert.match(out, /\[U1 · 2026-01-02 03:04Z\] \(body dropped to save space: 777 chars; see the transcript\)/);
	assert.match(out, /\[A\] \(prose dropped to save space: 55 chars; see the transcript\)/);
	assert.match(out, /\[… 2 tool calls omitted to save space …\]\n→ read path="kept\.ts"/);
});

test("renderCheckpoint points at the transcript, or says it is unrecoverable", () => {
	assert.match(renderCheckpoint({ ...baseInput, sessionFile: "/tmp/s.jsonl" }), /intact in \/tmp\/s\.jsonl/);
	assert.match(renderCheckpoint(baseInput), /not persisted, so removed content cannot be recovered/);
});

test("renderCheckpoint tells the agent to keep working and includes optional sections only when non-empty", () => {
	const bare = renderCheckpoint(baseInput);
	assert.match(bare, /Resume: .*do not restart/);
	assert.match(bare, /## State summary\n\n## Goal\nship it/);
	for (const absent of ["## Record", "<read-files>", "<modified-files>"]) assert.ok(!bare.includes(absent), absent);
	const full = renderCheckpoint({ ...baseInput, readFiles: ["a.ts"], modifiedFiles: ["b.ts"] });
	assert.match(full, /<read-files>\na\.ts\n<\/read-files>/);
	assert.match(full, /<modified-files>\nb\.ts\n<\/modified-files>/);
});
