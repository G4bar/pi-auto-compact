import type { CompactionEntry } from "@earendil-works/pi-coding-agent";
import { type Facts, type RecordEvent, utcMinute } from "./span.ts";

// Checkpoint: a record (user messages and assistant prose verbatim unless shortened, one-line tool
// signatures) + a model-written state summary + file lists, with the raw transcript left on disk as the
// complete fallback. How much of this the agent actually retains is not measured. Everything here is pure.


/** One step of the record. User and assistant text are verbatim unless shortened (then it says so). */
export type RecordItem =
	| { k: "u"; n: number; at: number; text: string; len: number }
	| { k: "a"; at: number; text: string; len: number }
	| { k: "t"; sig: string };
// `text: ""` / `sig: ""` mean "dropped to stay within the budget"; `len` keeps the original size.

/** Everything the next compaction needs to carry forward. Stored in `CompactionEntry.details`. */
export interface Carried {
	v: 2;
	state: string;
	record: RecordItem[];
}

/** pi-compatible file lists plus our state. */
export interface CheckpointDetails {
	readFiles: string[];
	modifiedFiles: string[];
	checkpoint: Carried;
}

const PROSE_MAX_CHARS = 4_000;
const PROSE_HEAD_CHARS = 2_800;
const PROSE_TAIL_CHARS = 1_000;
const USER_OVERHEAD_CHARS = 48; // "[U12 · 2026-11-22 23:48Z]" header
const ASSISTANT_OVERHEAD_CHARS = 8; // "[A]" header and separator
const TOOL_OVERHEAD_CHARS = 3; // "→ "
const MAX_FILES = 200;
export const MAX_STATE_CHARS = 30_000;

/** Record budget in chars: a quarter of the compaction threshold, between 4k and 40k tokens. */
export const recordBudgetChars = (thresholdTokens: number) =>
	Math.min(Math.max(Math.floor(thresholdTokens * 0.25), 4_000), 40_000) * 4;

export function elideMiddle(text: string, max: number, head: number, tail: number): string {
	if (text.length <= max) return text;
	const omitted = text.length - head - tail;
	return `${text.slice(0, head)}\n[… ${omitted} chars omitted …]\n${text.slice(text.length - tail)}`;
}

const elideProse = (text: string) => elideMiddle(text, PROSE_MAX_CHARS, PROSE_HEAD_CHARS, PROSE_TAIL_CHARS);

const cost = (item: RecordItem) =>
	item.k === "t"
		? item.sig ? item.sig.length + TOOL_OVERHEAD_CHARS : 0
		: item.text.length + (item.k === "u" ? USER_OVERHEAD_CHARS : ASSISTANT_OVERHEAD_CHARS);

/**
 * Append `events` to the previously recorded items. Over-long prose keeps head and tail. When the total
 * exceeds `budgetChars`, content is dropped oldest first in order of value: tool signatures, then assistant
 * prose, then user messages. Dropped items leave a numbered stub (the text is still in the transcript);
 * the newest user message and the newest assistant message always keep their text.
 */
export function buildRecord(prev: readonly RecordItem[], events: readonly RecordEvent[], budgetChars: number): RecordItem[] {
	let n = 0;
	for (const item of prev) if (item.k === "u") n = Math.max(n, item.n);

	const items: RecordItem[] = prev.map((item) => ({ ...item }));
	for (const event of events) {
		if (event.k === "t") items.push({ k: "t", sig: event.sig });
		else if (event.k === "a") items.push({ k: "a", at: event.at, text: elideProse(event.text), len: event.text.length });
		else items.push({ k: "u", n: ++n, at: event.at, text: elideProse(event.text), len: event.text.length });
	}

	let total = items.reduce((sum, item) => sum + cost(item), 0);
	const newestAssistant = items.findLastIndex((item) => item.k === "a");
	const newestUser = items.findLastIndex((item) => item.k === "u");

	const shrink = (droppable: (item: RecordItem, index: number) => boolean) => {
		for (let i = 0; i < items.length && total > budgetChars; i++) {
			const item = items[i];
			if (!droppable(item, i)) continue;
			total -= cost(item);
			if (item.k === "t") item.sig = "";
			else item.text = "";
			total += cost(item);
		}
	};
	shrink((item) => item.k === "t" && item.sig !== "");
	shrink((item, i) => item.k === "a" && item.text !== "" && i !== newestAssistant);
	shrink((item, i) => item.k === "u" && item.text !== "" && i !== newestUser);
	return items;
}

export function mergeFiles(
	previous: { readFiles: readonly string[]; modifiedFiles: readonly string[] } | undefined,
	facts: Pick<Facts, "readFiles" | "modifiedFiles">,
): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...(previous?.modifiedFiles ?? []), ...facts.modifiedFiles]);
	const read = new Set([...(previous?.readFiles ?? []), ...facts.readFiles].filter((f) => !modified.has(f)));
	return {
		readFiles: [...read].slice(-MAX_FILES).sort(),
		modifiedFiles: [...modified].slice(-MAX_FILES).sort(),
	};
}

/** Keep the newest part of an over-long state text (later content is the most recent). */
export function capState(state: string): string {
	if (state.length <= MAX_STATE_CHARS) return state;
	return `[… older state omitted …]\n${state.slice(state.length - MAX_STATE_CHARS)}`;
}

// ---------------------------------------------------------------------------------------------------
// Reading what a previous compaction stored

const isStringArray = (x: unknown): x is string[] => Array.isArray(x) && x.every((s) => typeof s === "string");

function isRecordItem(x: unknown): x is RecordItem {
	const item = x as Record<string, unknown> | null;
	if (!item || typeof item !== "object") return false;
	if (item.k === "t") return typeof item.sig === "string";
	const textual = typeof item.at === "number" && typeof item.text === "string" && typeof item.len === "number";
	if (item.k === "a") return textual;
	return item.k === "u" && textual && typeof item.n === "number";
}

function isCarried(x: unknown): x is Carried {
	const c = x as Partial<Carried> | null;
	return !!c && c.v === 2 && typeof c.state === "string" && Array.isArray(c.record) && c.record.every(isRecordItem);
}

export interface Previous {
	/** Our state, when the previous compaction was one of our checkpoints. */
	carried?: Carried;
	/** Text to iterate on: our state, or the whole previous summary when it came from elsewhere. */
	state?: string;
	readFiles: string[];
	modifiedFiles: string[];
}

/** Interpret a previous compaction entry (ours, pi's default, or another extension's). */
export function readPrevious(entry: CompactionEntry | undefined): Previous {
	if (!entry) return { readFiles: [], modifiedFiles: [] };
	const details = (entry.details ?? {}) as { readFiles?: unknown; modifiedFiles?: unknown; checkpoint?: unknown };
	const carried = isCarried(details.checkpoint) ? details.checkpoint : undefined;
	return {
		carried,
		state: carried ? carried.state : entry.summary,
		readFiles: isStringArray(details.readFiles) ? details.readFiles : [],
		modifiedFiles: isStringArray(details.modifiedFiles) ? details.modifiedFiles : [],
	};
}

// ---------------------------------------------------------------------------------------------------
// Rendering

export interface RenderInput {
	/** Session JSONL path; undefined for ephemeral sessions. */
	sessionFile?: string;
	record: readonly RecordItem[];
	state: string;
	readFiles: readonly string[];
	modifiedFiles: readonly string[];
	/** Name of the tool that can search and re-read removed entries; when set, recovery points to it instead of the transcript file. */
	recallTool?: string;
}

function renderRecord(items: readonly RecordItem[], recallTool?: string): string {
	const where = recallTool ? `search it with ${recallTool}` : "see the transcript";
	const blocks: string[] = [];
	for (let i = 0; i < items.length; ) {
		const item = items[i];
		if (item.k === "t") {
			// consecutive tool calls form one block; dropped signatures collapse into a count
			const lines: string[] = [];
			let omitted = 0;
			for (; i < items.length; i++) {
				const tool = items[i];
				if (tool.k !== "t") break;
				if (tool.sig) lines.push(`→ ${tool.sig}`);
				else omitted++;
			}
			if (omitted > 0) lines.unshift(`[… ${omitted} tool call${omitted === 1 ? "" : "s"} omitted to save space …]`);
			blocks.push(lines.join("\n"));
			continue;
		}
		if (item.k === "u") {
			const head = `[U${item.n} · ${utcMinute(item.at)}]`;
			blocks.push(item.text ? `${head}\n${item.text}` : `${head} (body dropped to save space: ${item.len} chars; ${where})`);
		} else {
			blocks.push(item.text ? `[A]\n${item.text}` : `[A] (prose dropped to save space: ${item.len} chars; ${where})`);
		}
		i++;
	}
	return blocks.join("\n\n");
}

export function renderCheckpoint(input: RenderInput): string {
	const { recallTool } = input;
	const recovery = recallTool
		? `Use the ${recallTool} tool to get removed content back: search by a distinctive string (a file path, an error message, a command) to find entries and their ids, then read one in full by id.${input.sessionFile ? ` The raw transcript is also intact in ${input.sessionFile} (append-only JSONL).` : ""}`
		: input.sessionFile
		? `The raw transcript is intact in ${input.sessionFile} (append-only JSONL, one entry per line). To recover exact details, search it for a distinctive string (rg -F or grep -F), then print the matching line (jq . pretty-prints it).`
		: "This session is not persisted, so removed content cannot be recovered; re-read files and re-run commands if you need them again.";

	const parts = [
		`# Context checkpoint (automatic)

Older history was compacted to keep this session small. This checkpoint replaces it; the messages after it are unchanged.

What it holds:
- Record (verbatim): the user messages and your own prose from the compacted span, in order, with each tool call reduced to a one-line signature ("→ tool args"; "✗" marks a failed call). The prose is a record of what was said, not verification of its claims.
- State summary (model-written): facts learned from tool output and the state of the work. It may paraphrase, so verify exact values before relying on them.
- File lists (computed from the tool calls).
Removed: tool outputs and reasoning. Where text was shortened the record says so ("omitted", "dropped"). Treat anything you only know from removed content as unverified, and re-read a file before editing it: none of the listed files is in context.

Recovery: ${recovery}

Resume: this compaction happened automatically while you were working. Continue from the latest messages below; do not restart, re-plan from scratch, or ask the user to repeat anything unless something is truly missing. Re-run a check before trusting an old result.`,
	];

	if (input.record.length > 0) parts.push(`## Record (verbatim, oldest first)\n\n${renderRecord(input.record, recallTool)}`);
	parts.push(`## State summary\n\n${input.state.trim()}`);
	if (input.readFiles.length > 0) parts.push(`<read-files>\n${input.readFiles.join("\n")}\n</read-files>`);
	if (input.modifiedFiles.length > 0) parts.push(`<modified-files>\n${input.modifiedFiles.join("\n")}\n</modified-files>`);
	return parts.join("\n\n");
}
