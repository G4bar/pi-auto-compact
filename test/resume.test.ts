import assert from "node:assert/strict";
import { test } from "node:test";
import { ResumeGuard, handsBackToUser } from "../src/resume.ts";

const STALL = "f2.txt read. Next up is f3.txt.";

test("does not resume when nothing was compacted", () => {
	assert.equal(new ResumeGuard().shouldResume("completed", STALL), false);
});

test("resumes once when the agent goes quiet right after a compaction", () => {
	const guard = new ResumeGuard();
	guard.compacted();
	guard.turnEnded(0); // next turn: text only
	assert.equal(guard.shouldResume("completed", STALL), true);
	assert.equal(guard.shouldResume("completed", STALL), false); // at most once
});

test("a later turn with tool calls proves the agent resumed", () => {
	const guard = new ResumeGuard();
	guard.compacted();
	guard.turnEnded(1);
	assert.equal(guard.shouldResume("completed", STALL), false);
});

test("stall replies are caught whatever their wording or language", () => {
	// measured replies from models that stopped right after a compaction
	for (const reply of [
		"Read f3.txt.",
		"Read `f2.txt` (700 lines). Ready for the next file.",
		"`f3.txt` 已读取完成，接下来我会读取 `f4.txt`。",
		"f5.txt is read. Next, f6.txt.",
		"Ho letto f2.txt.",
		"",
		"   ",
	]) {
		const guard = new ResumeGuard();
		guard.compacted();
		assert.equal(guard.shouldResume("completed", reply), true, JSON.stringify(reply));
	}
});

test("a compaction on the text-only turn that announces the next step still resumes", () => {
	// the observed failure: the model answered "f5.txt is read. Next, f6.txt." and the compaction ran on that turn
	const guard = new ResumeGuard();
	guard.turnEnded(0);
	guard.compacted();
	assert.equal(guard.shouldResume("completed", "f5.txt is read. Next, f6.txt."), true);
});

test("a final answer right after a compaction is nudged too (accepted cost: one extra turn)", () => {
	const guard = new ResumeGuard();
	guard.turnEnded(0);
	guard.compacted();
	assert.equal(guard.shouldResume("completed", "ALL-SIX-READ"), true);
});

test("replies that hand the conversation back to the user are never nudged", () => {
	for (const reply of [
		"Which of the two options do you prefer?",
		"Should I continue with the migration?",
		"Vuoi che continui con la migrazione？",
		"The refactor is complete. Let me know if you want changes.",
		"Ecco il risultato, fammi sapere se serve altro.",
	]) {
		const guard = new ResumeGuard();
		guard.compacted();
		assert.equal(guard.shouldResume("completed", reply), false, JSON.stringify(reply));
	}
});

test("never resumes an aborted or failed run, and clears the state", () => {
	const guard = new ResumeGuard();
	guard.compacted();
	assert.equal(guard.shouldResume("aborted", STALL), false);
	assert.equal(guard.shouldResume("completed", STALL), false);
	guard.compacted();
	assert.equal(guard.shouldResume("error", STALL), false);
});

test("reset disarms the guard", () => {
	const guard = new ResumeGuard();
	guard.compacted();
	guard.reset();
	assert.equal(guard.shouldResume("completed", STALL), false);
});

test("handsBackToUser: questions and invitations only", () => {
	assert.equal(handsBackToUser("Should I go on?"), true);
	assert.equal(handsBackToUser("Should I go on? "), true);
	assert.equal(handsBackToUser("Done. Let me know if you want changes."), true);
	assert.equal(handsBackToUser("Read f3.txt."), false);
	assert.equal(handsBackToUser("Is it `a?b` or c. Next, d."), false);
	assert.equal(handsBackToUser(""), false);
});
