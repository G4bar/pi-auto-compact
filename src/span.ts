import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CompactionEntry, ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";

export type EstimateTokens = (message: AgentMessage) => number;

/** The slice of history a checkpoint replaces. */
export interface Span {
	/** Messages to replace, oldest first (a split user-message span is included in full). */
	messages: AgentMessage[];
	/** First entry that stays verbatim after the checkpoint. */
	firstKeptEntryId: string;
	/** Latest compaction this span continues from, if any. */
	previous?: CompactionEntry;
}

// Same rule as pi: a cut may land on any model-visible message except a tool result,
// which must stay next to its tool call.
const CUT_ROLES = new Set<string>(["user", "assistant", "bashExecution", "custom", "branchSummary", "compactionSummary"]);
const isCutPoint = (message: AgentMessage) => CUT_ROLES.has(message.role);

/**
 * Choose what to compact from pi's projected context, mirroring pi's own cut-point rule: keep about
 * `keepRecentTokens` of the newest messages verbatim and replace everything older, starting after the
 * latest compaction. Returns undefined when there is nothing worth compacting.
 */
export function planSpan(
	entries: readonly ProjectedSessionEntry[],
	keepRecentTokens: number,
	estimate: EstimateTokens,
): Span | undefined {
	// The newest compaction comes first in the projection; its retained tail follows it.
	const prevIndex = entries.findIndex((e) => e.sourceEntry.type === "compaction" && e.messages.length > 0);
	const start = prevIndex + 1;
	const previous = prevIndex >= 0 ? (entries[prevIndex].sourceEntry as CompactionEntry) : undefined;

	const cutPoints: number[] = [];
	for (let i = start; i < entries.length; i++) {
		if (entries[i].sourceEntry.type !== "compaction" && entries[i].messages.some(isCutPoint)) cutPoints.push(i);
	}
	if (cutPoints.length === 0) return undefined;

	let kept = 0;
	let cut = -1;
	for (let i = entries.length - 1; i >= start; i--) {
		for (const message of entries[i].messages) kept += estimate(message);
		if (kept >= keepRecentTokens) {
			cut = cutPoints.find((c) => c >= i) ?? cutPoints[cutPoints.length - 1];
			break;
		}
	}
	if (cut < 0) return undefined; // everything fits in the kept budget

	const messages = entries
		.slice(start, cut)
		.filter((e) => e.sourceEntry.type !== "compaction")
		.flatMap((e) => e.messages);
	if (messages.length === 0) return undefined;

	return { messages, firstKeptEntryId: entries[cut].sourceEntry.id, previous };
}

/** One step of the compacted conversation, in order. */
export type RecordEvent =
	| { k: "u"; at: number; text: string } // user message
	| { k: "a"; at: number; text: string } // assistant prose (reasoning excluded)
	| { k: "t"; sig: string }; // tool call, one-line signature

export interface Facts {
	events: RecordEvent[];
	readFiles: string[];
	modifiedFiles: string[];
}

const ARG_MAX_CHARS = 100;
const SIGNATURE_MAX_CHARS = 220;
const LEADING_ARGS = ["path", "command", "pattern", "url", "query"];

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
const argRank = (key: string) => {
	const i = LEADING_ARGS.indexOf(key);
	return i === -1 ? LEADING_ARGS.length : i;
};

/** `name key="value" key2=3`: the tool and its truncated arguments on one line; a trailing ✗ marks a failed call. */
export function toolSignature(name: string, args: Record<string, unknown>, failed: boolean): string {
	const parts = Object.keys(args)
		.filter((key) => args[key] !== null && args[key] !== undefined)
		.sort((a, b) => argRank(a) - argRank(b)) // stable: the rest keeps its order
		.map((key) => {
			const value = args[key];
			const text =
				typeof value === "string"
					? JSON.stringify(clip(oneLine(value), ARG_MAX_CHARS))
					: clip(oneLine(JSON.stringify(value) ?? ""), ARG_MAX_CHARS);
			return `${key}=${text}`;
		});
	return clip([name, ...parts].join(" "), SIGNATURE_MAX_CHARS) + (failed ? " ✗" : "");
}

function userText(content: string | readonly { type: string; text?: string }[]): string {
	if (typeof content === "string") return content;
	return content.map((block) => (block.type === "text" ? (block.text ?? "") : `[${block.type}]`)).join("\n");
}

/** Deterministic record of the messages being compacted (no model involved). */
export function extractFacts(messages: readonly AgentMessage[]): Facts {
	const failed = new Set<string>();
	for (const message of messages) if (message.role === "toolResult" && message.isError) failed.add(message.toolCallId);

	const events: RecordEvent[] = [];
	const read = new Set<string>();
	const written = new Set<string>();

	for (const message of messages) {
		if (message.role === "user") {
			const text = userText(message.content).trim();
			if (text) events.push({ k: "u", at: message.timestamp, text });
		} else if (message.role === "assistant") {
			let prose: string[] = [];
			const flush = () => {
				const text = prose.join("\n").trim();
				if (text) events.push({ k: "a", at: message.timestamp, text });
				prose = [];
			};
			for (const block of message.content) {
				if (block.type === "text") prose.push(block.text);
				else if (block.type === "toolCall") {
					flush();
					const args = block.arguments as Record<string, unknown>;
					const failedCall = failed.has(block.id);
					events.push({ k: "t", sig: toolSignature(block.name, args, failedCall) });
					const path = typeof args.path === "string" ? args.path : undefined;
					if (!path || failedCall) continue;
					if (block.name === "read") read.add(path);
					else if (block.name === "edit" || block.name === "write") written.add(path);
				}
			}
			flush();
		}
	}
	return { events, readFiles: [...read], modifiedFiles: [...written] };
}
