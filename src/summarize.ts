import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Usage } from "@earendil-works/pi-ai";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import type { CompactionEntry, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type CheckpointDetails, buildRecord, capState, mergeFiles, readPrevious, renderCheckpoint } from "./checkpoint.ts";
import { type ThinkingChoice, chooseSummarizer, modelKey, parseModelKey, resolveThinking } from "./model.ts";
import { extractFacts } from "./span.ts";

const SYSTEM_PROMPT =
	"You write context checkpoints for an AI coding agent. Read the conversation and write the state summary requested. Do NOT continue the conversation, answer its questions, or call tools. Output only the summary.";

const MAX_SUMMARY_TOKENS = 16_000;
// Thinking tokens count against the output cap, so a summary with thinking on gets more room.
const MAX_SUMMARY_TOKENS_THINKING = 32_000;
const ATTEMPTS = 2;

function statePrompt(conversation: string, previousState: string | undefined, focus: string | undefined): string {
	const update = previousState
		? "Update <previous-state> with the conversation above: keep everything still relevant, add what is new, move finished items from In Progress to Done, and drop only what is clearly obsolete.\n"
		: "";
	return `<conversation>
${conversation}
</conversation>

${previousState ? `<previous-state>\n${previousState}\n</previous-state>\n\n` : ""}Write the "State summary" of a context checkpoint. Another LLM will read it, together with a verbatim record of the user's messages and the agent's own prose (do not restate those) and the most recent messages, to continue the work without seeing the conversation above. Tool outputs are NOT in that record, so the facts learned from them are what this summary is for.
${update}
Precision over brevity:
- Quote, never paraphrase, anything exact: error messages and key stack-trace lines, identifiers, file paths, URLs, command lines, config keys and values, version numbers, test names and results, numbers. Use backticks.
- Separate what was VERIFIED (seen in tool output) from what is ASSUMED or only claimed.
- Tool results above are cut at 2,000 characters: never estimate, extrapolate or round what you cannot see (sizes, counts, totals); write "not visible" instead.
- Record every constraint, prohibition and decision with its rationale and who set it.
- Never invent anything that is not in the conversation.

Use exactly this format:

## Goal
## Constraints & Decisions
## Progress
### Done
### In Progress
(the exact action under way when the conversation ended)
### Blocked / Open questions
## Next Steps
(ordered; the first must be concrete enough to execute immediately)
## Critical Context
(exact values, snippets and references needed to continue)${focus ? `\n\nAdditional focus: ${focus}` : ""}`;
}

/** One model call that writes (or updates) the state summary. Throws on any failure. */
async function generateState(
	ctx: ExtensionContext,
	messages: readonly AgentMessage[],
	previousState: string | undefined,
	focus: string | undefined,
	signal: AbortSignal | undefined,
	summarizerKey: string | undefined,
	thinking: ThinkingChoice | undefined,
	sessionThinking: string,
): Promise<{ text: string; usage: Usage; model: string; thinking: string; note?: string }> {
	const active = ctx.model;
	if (!active) throw new Error("no model selected");
	const prompt = statePrompt(serializeConversation(convertToLlm([...messages])), previousState, focus);

	const parsed = summarizerKey ? parseModelKey(summarizerKey) : undefined;
	const found = parsed ? ctx.modelRegistry.find(parsed.provider, parsed.id) : undefined;
	const configured = found && ctx.modelRegistry.hasConfiguredAuth(found) ? found : undefined;
	const neededTokens = Math.ceil(prompt.length / 3) + MAX_SUMMARY_TOKENS; // ~3 chars/token: deliberately pessimistic
	const { model, note } = chooseSummarizer(summarizerKey, configured, active, neededTokens);

	// the chosen level, limited to what this model supports (a non-reasoning model gets none)
	const level = resolveThinking(thinking, sessionThinking, getSupportedThinkingLevels(model));
	const response = await ctx.modelRegistry
		.streamSimple(
			model,
			{ systemPrompt: SYSTEM_PROMPT, messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
			{
				maxTokens: Math.min(model.maxTokens, level === "off" ? MAX_SUMMARY_TOKENS : MAX_SUMMARY_TOKENS_THINKING),
				reasoning: level === "off" ? undefined : level,
				signal,
				cacheRetention: "none",
				sessionId: randomUUID(),
			},
		)
		.result();
	if (response.stopReason === "error" || response.stopReason === "aborted") {
		throw new Error(response.errorMessage ?? response.stopReason);
	}
	if (response.stopReason === "length") throw new Error("the summary hit the token cap");
	if (response.content.some((block) => block.type === "toolCall")) throw new Error("the summarizer tried to call a tool");
	const text = response.content
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("\n")
		.trim();
	if (!text) throw new Error("the summary was empty");
	return { text, usage: response.usage, model: modelKey(model), thinking: level, note };
}

/** State text used when no model could write one: the record is complete, so only the previous state is carried. */
function fallbackState(previousState: string | undefined, reason: string): string {
	return [
		`(A model-written summary was unavailable for the latest span: ${reason}. The record above is complete for it; the state from the previous checkpoint follows, without updates.)`,
		previousState ? `### Previous state\n\n${previousState}` : "",
	]
		.filter(Boolean)
		.join("\n\n");
}

export interface BuildInput {
	ctx: ExtensionContext;
	/** Messages being replaced, oldest first. */
	messages: readonly AgentMessage[];
	/** The compaction this one continues from. */
	previous?: CompactionEntry;
	/** Extra focus from `/compact <instructions>`. */
	focus?: string;
	signal?: AbortSignal;
	/** `provider/id` configured with `/autocompact model`; undefined = the active model. */
	summarizerKey?: string;
	/** Thinking level of the summary model; undefined = off. */
	thinking?: ThinkingChoice;
	/** The session's current thinking level, for `thinking: "session"`. */
	sessionThinking?: string;
	/** Size limit of the verbatim record, in chars. */
	recordBudgetChars: number;
	/** Name of the recall tool when it is active; the checkpoint then points to it. */
	recallTool?: string;
}

export interface Built {
	summary: string;
	details: CheckpointDetails;
	usage?: Usage;
	/** Set when the model summary failed and the deterministic fallback was used. */
	degraded?: string;
	/** Set when the configured summary model could not be used as is. */
	note?: string;
}

/** Build the checkpoint. Only rejects when `signal` aborts; any other failure degrades. */
export async function buildCheckpoint({
	ctx,
	messages,
	previous,
	focus,
	signal,
	summarizerKey,
	thinking,
	sessionThinking = "off",
	recordBudgetChars,
	recallTool,
}: BuildInput): Promise<Built> {
	const prev = readPrevious(previous);
	const facts = extractFacts(messages);

	let state: string;
	let usage: Usage | undefined;
	let degraded: string | undefined;
	let note: string | undefined;
	for (let attempt = 1; ; attempt++) {
		try {
			// a failure with the configured model retries with the active one
			const generated = await generateState(
				ctx,
				messages,
				prev.state,
				focus,
				signal,
				attempt === 1 ? summarizerKey : undefined,
				thinking,
				sessionThinking,
			);
			state = generated.text;
			usage = generated.usage;
			note = generated.note ?? note;
			break;
		} catch (error) {
			if (signal?.aborted) throw error;
			const reason = error instanceof Error ? error.message : String(error);
			if (attempt === 1 && summarizerKey) note = `summary model ${summarizerKey} failed (${reason}); retried with the active model`;
			if (attempt < ATTEMPTS) continue;
			degraded = reason;
			state = fallbackState(prev.state, reason);
			break;
		}
	}
	state = capState(state);

	const files = mergeFiles(prev, facts);
	const record = buildRecord(prev.carried?.record ?? [], facts.events, recordBudgetChars);

	const summary = renderCheckpoint({
		sessionFile: ctx.sessionManager.getSessionFile(),
		record,
		state,
		readFiles: files.readFiles,
		modifiedFiles: files.modifiedFiles,
		recallTool,
	});
	return { summary, usage, degraded, note, details: { ...files, checkpoint: { v: 2, state, record } } };
}
