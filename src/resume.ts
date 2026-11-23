/**
 * Safety net for "the agent went quiet right after a compaction".
 *
 * The compaction itself never interrupts the agent (it is applied in place at a turn boundary), but a
 * model that just lost its scrollback often answers with a status line ("Read f3.txt.", "Ready for the
 * next file") and ends the turn without calling a tool. So: every compaction arms the guard; any later
 * turn with tool calls proves the agent resumed and disarms it. If the run is about to settle while still
 * armed, we ask for exactly one continuation.
 *
 * The trigger is structural (a text-only turn right after a compaction), not a guess about the wording:
 * measured stall replies included "Read f3.txt." and a sentence in Chinese, which no phrase list would
 * catch. The price is that a genuine final answer written right after a compaction is nudged too; the
 * message tells the agent to repeat it unchanged, so that costs one extra turn. Replies that hand the
 * conversation back to the user (a question, "let me know") are never nudged.
 */
export class ResumeGuard {
	private armed = false;

	/** Call at the start of every turn_end, before deciding whether to compact. */
	turnEnded(toolResultCount: number): void {
		if (toolResultCount > 0) this.armed = false;
	}

	/** Call when a compaction was appended at the end of a turn. */
	compacted(): void {
		this.armed = true;
	}

	/** Call when a new run starts. */
	reset(): void {
		this.armed = false;
	}

	/** Call at the final boundary of a run with the agent's last reply. True when one continuation should be requested. */
	shouldResume(outcome: "completed" | "aborted" | "error", lastReply: string): boolean {
		const resume = this.armed && outcome === "completed" && !handsBackToUser(lastReply);
		this.armed = false; // at most one nudge per compaction
		return resume;
	}
}

const ASKS_USER = /\b(let me know|fammi sapere|dimmi se|tell me if)\b/i;

/** Does this reply give the turn back to the user (a question or an explicit invitation), as opposed to stalling? */
export function handsBackToUser(reply: string): boolean {
	const text = reply.trim();
	if (/[?？][\s"')\]*_」）]*$/.test(text)) return true;
	return ASKS_USER.test(text.slice(-200));
}

export const RESUME_MESSAGE =
	"[auto-compact] Your context was just compacted while you were working, and your last reply ended without a tool call. If the task is NOT finished, continue now with the next step (make the tool call; do not just announce it). If it IS finished, repeat your final reply unchanged.";
