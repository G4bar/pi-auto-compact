/**
 * Safety net for "the agent went quiet right after a compaction".
 *
 * The compaction itself never interrupts the agent (it is applied in place at a turn boundary), but a
 * model that just lost its scrollback sometimes answers "Next: X" and ends the turn without calling a
 * tool. So: when we compact in the middle of work (the turn had tool calls, so the agent was about to go
 * on) we arm the guard; any later turn with tool calls proves the agent resumed and disarms it. If the run
 * is about to settle while still armed, we ask for exactly one continuation.
 */
export class ResumeGuard {
	private armed = false;

	/** Call at the start of every turn_end, before deciding whether to compact. */
	turnEnded(toolResultCount: number): void {
		if (toolResultCount > 0) this.armed = false;
	}

	/** Call when a compaction was appended at a turn that ended with `toolResultCount` tool results. */
	compactedAt(toolResultCount: number): void {
		this.armed = toolResultCount > 0;
	}

	/** Call when a new run starts. */
	reset(): void {
		this.armed = false;
	}

	/**
	 * Call at the final boundary of a run with the agent's last reply. True when one continuation should be
	 * requested: only if the reply reads like an announced-but-not-taken next step, so a genuine final answer
	 * is never second-guessed.
	 */
	shouldResume(outcome: "completed" | "aborted" | "error", lastReply: string): boolean {
		const resume = this.armed && outcome === "completed" && looksUnfinished(lastReply);
		this.armed = false; // at most one nudge per compaction
		return resume;
	}
}

// Phrases that announce an action (English and Italian). Deliberately narrow: a missed stall just behaves
// as before, while a false positive costs an extra turn and may reword a genuine final answer.
const INTENT =
	/\b(next|up next|let me|let's|i'll|i will|i am going to|i'm going to|going to|moving on|proceed(?:ing)?|prossim[oa]|procedo|continuo|passo a|vado a|vediamo|ora (?:leggo|controllo|verifico|procedo|passo|eseguo|lancio))\b/i;
const NOT_A_STALL = /\b(let me know|fammi sapere|dimmi se)\b/i;

/** Does this final reply read as "about to do something" rather than a finished answer or a question? */
export function looksUnfinished(reply: string): boolean {
	const text = reply.trim();
	if (!text) return true; // an empty reply after a compaction is a stall
	if (/\?[\s"')\]*_]*$/.test(text)) return false; // asking the user something
	const tail = text.slice(-200);
	if (NOT_A_STALL.test(tail)) return false;
	return /(?::|…|\.\.\.)\s*$/.test(text) || INTENT.test(tail);
}

export const RESUME_MESSAGE =
	"[auto-compact] Your context was just compacted while you were working, and your last reply ended without a tool call. If the task is NOT finished, continue now with the next step (make the tool call; do not just announce it). If it IS finished, repeat your final reply unchanged.";
