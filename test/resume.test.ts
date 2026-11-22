import assert from "node:assert/strict";
import { test } from "node:test";
import { ResumeGuard, looksUnfinished } from "../src/resume.ts";

const STALL = "f2.txt read. Next up is f3.txt.";

test("does not resume when nothing was compacted", () => {
	assert.equal(new ResumeGuard().shouldResume("completed", STALL), false);
});

test("resumes once when the agent goes quiet right after a mid-work compaction", () => {
	const guard = new ResumeGuard();
	guard.compactedAt(1); // compacted on a turn that had tool calls
	guard.turnEnded(0); // next turn: text only
	assert.equal(guard.shouldResume("completed", STALL), true);
	assert.equal(guard.shouldResume("completed", STALL), false); // at most once
});

test("a later turn with tool calls proves the agent resumed", () => {
	const guard = new ResumeGuard();
	guard.compactedAt(2);
	guard.turnEnded(1);
	assert.equal(guard.shouldResume("completed", STALL), false);
});

test("a compaction on a final text-only turn does not arm the guard", () => {
	const guard = new ResumeGuard();
	guard.compactedAt(0);
	assert.equal(guard.shouldResume("completed", STALL), false);
});

test("a genuine final answer is not second-guessed", () => {
	const guard = new ResumeGuard();
	guard.compactedAt(1);
	assert.equal(guard.shouldResume("completed", "ALL-SIX-READ"), false);
});

test("never resumes an aborted or failed run, and clears the state", () => {
	const guard = new ResumeGuard();
	guard.compactedAt(1);
	assert.equal(guard.shouldResume("aborted", STALL), false);
	assert.equal(guard.shouldResume("completed", STALL), false);
	guard.compactedAt(1);
	assert.equal(guard.shouldResume("error", STALL), false);
});

test("reset disarms the guard", () => {
	const guard = new ResumeGuard();
	guard.compactedAt(1);
	guard.reset();
	assert.equal(guard.shouldResume("completed", STALL), false);
});

test("looksUnfinished flags announced next steps and empty replies", () => {
	for (const reply of [
		"Next: f3.txt.",
		"Read 3 of 6 done. Next is `/tmp/ac-work/f4.txt`.",
		"Let me run the tests",
		"I'll check the config now.",
		"Reading the file:",
		"Checking…",
		"Prossimo passo: leggere f4.txt.",
		"Ora controllo i test.",
		"",
		"   ",
	]) {
		assert.equal(looksUnfinished(reply), true, JSON.stringify(reply));
	}
});

test("looksUnfinished leaves final answers and questions alone", () => {
	for (const reply of [
		"ALL-SIX-READ",
		"Done. All 12 tests pass.",
		"The bug was in parser.ts: it lowercased the key twice.",
		"Fatto. Tutti i test passano.",
		"Which of the two options do you prefer?",
		"Should I continue with the migration?",
		"The refactor is complete. Let me know if you want changes.",
		"Ecco il risultato, fammi sapere se serve altro.",
	]) {
		assert.equal(looksUnfinished(reply), false, JSON.stringify(reply));
	}
});
