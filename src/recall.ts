import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { toolSignature } from "./span.ts";

// Recall: look up and re-read session entries that a compaction removed from the context. Everything here
// is pure (no pi runtime): it works on the entries pi hands to the tool, persisted or not.

export const RECALL_TOOL_NAME = "session_recall";

export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 50;
export const DEFAULT_PAGE_CHARS = 12_000;
export const MIN_PAGE_CHARS = 1_000;
export const MAX_PAGE_CHARS = 40_000;
const SNIPPET_RADIUS = 150;

export type SearchScope = "compacted" | "all";

export interface ToolCallInfo {
	name: string;
	args: Record<string, unknown>;
}

/** The readable content of one entry. */
export interface EntryText {
	kind: "user" | "assistant" | "toolResult" | "custom";
	/** Short heading: the role, or the tool call (name and arguments) that a result answers. */
	label: string;
	/** Unix ms. */
	at: number;
	text: string;
}

export interface Hit {
	id: string;
	label: string;
	at: number;
	/** The entry is still part of the model's context. */
	inContext: boolean;
	/** Occurrences of the query in the entry. */
	matches: number;
	snippet: string;
}

export interface SearchResult {
	/** Newest first, at most `limit`. */
	hits: Hit[];
	/** Matching entries before `limit` was applied. */
	total: number;
}

const clamp = (value: number | undefined, min: number, max: number, fallback: number) =>
	typeof value === "number" && Number.isFinite(value) ? Math.min(Math.max(Math.floor(value), min), max) : fallback;

const utcMinute = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")}Z`;

/** Tool calls of the assistant messages, by call id, so a tool result can show what was asked. */
export function buildToolCallIndex(entries: readonly SessionEntry[]): Map<string, ToolCallInfo> {
	const index = new Map<string, ToolCallInfo>();
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		for (const block of entry.message.content) {
			if (block.type === "toolCall") index.set(block.id, { name: block.name, args: block.arguments as Record<string, unknown> });
		}
	}
	return index;
}

function blocksText(content: string | readonly { type: string; text?: string }[]): string {
	if (typeof content === "string") return content;
	return content.map((block) => (block.type === "text" ? (block.text ?? "") : block.type === "image" ? "[image]" : `[${block.type}]`)).join("\n");
}

/**
 * What an entry says, in the same scope as the record: user text, assistant prose with one line per tool
 * call (reasoning excluded), tool results labelled with their call. Entries that carry no conversation
 * (compactions, model changes, bash runs hidden from the context, ...) give undefined.
 */
export function entryText(entry: SessionEntry, toolIndex: ReadonlyMap<string, ToolCallInfo>): EntryText | undefined {
	const result = (kind: EntryText["kind"], label: string, at: number, text: string): EntryText | undefined =>
		text.trim() ? { kind, label, at, text } : undefined;

	if (entry.type === "custom_message") {
		return result("custom", entry.customType, Date.parse(entry.timestamp), blocksText(entry.content));
	}
	if (entry.type !== "message") return undefined;

	const message = entry.message;
	switch (message.role) {
		case "user":
			return result("user", "user", message.timestamp, blocksText(message.content));
		case "assistant": {
			const lines: string[] = [];
			for (const block of message.content) {
				if (block.type === "text") lines.push(block.text);
				else if (block.type === "toolCall") lines.push(`→ ${toolSignature(block.name, block.arguments as Record<string, unknown>, false)}`);
			}
			return result("assistant", "assistant", message.timestamp, lines.join("\n"));
		}
		case "toolResult": {
			const call = toolIndex.get(message.toolCallId);
			return result("toolResult", toolSignature(call?.name ?? message.toolName, call?.args ?? {}, message.isError), message.timestamp, blocksText(message.content));
		}
		case "bashExecution": {
			if (message.excludeFromContext) return undefined;
			const failed = message.exitCode !== undefined && message.exitCode !== 0;
			return result("custom", toolSignature("bash", { command: message.command }, failed), message.timestamp, message.output);
		}
		default:
			return undefined;
	}
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface SearchOptions {
	query: string;
	scope?: SearchScope;
	limit?: number;
}

/**
 * Literal, case-insensitive search over `label + text` of the branch entries (oldest first), newest match
 * first. By default only entries missing from `visibleIds` (the current context) are searched.
 * Returns an error message when the query is empty.
 */
export function searchEntries(entries: readonly SessionEntry[], visibleIds: ReadonlySet<string>, options: SearchOptions): SearchResult | string {
	const query = options.query.trim();
	if (!query) return "The query is empty: pass a non-empty string to search for.";
	const scope = options.scope ?? "compacted";
	const limit = clamp(options.limit, 1, MAX_SEARCH_LIMIT, DEFAULT_SEARCH_LIMIT);

	const toolIndex = buildToolCallIndex(entries);
	const pattern = new RegExp(escapeRegExp(query), "gi"); // literal: the query is escaped
	const hits: Hit[] = [];
	let total = 0;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const inContext = visibleIds.has(entry.id);
		if (inContext && scope === "compacted") continue;
		const content = entryText(entry, toolIndex);
		if (!content) continue;

		const haystack = `${content.label}\n${content.text}`;
		const found = [...haystack.matchAll(pattern)];
		if (found.length === 0) continue;
		total++;
		if (hits.length >= limit) continue;

		const first = found[0].index;
		const start = Math.max(0, first - SNIPPET_RADIUS);
		const end = Math.min(haystack.length, first + query.length + SNIPPET_RADIUS);
		const snippet = `${start > 0 ? "…" : ""}${haystack.slice(start, end).replace(/\s+/g, " ").trim()}${end < haystack.length ? "…" : ""}`;
		hits.push({ id: entry.id, label: content.label, at: content.at, inContext, matches: found.length, snippet });
	}
	return { hits, total };
}

export function renderHits(hits: readonly Hit[], total: number, scope: SearchScope = "compacted"): string {
	if (hits.length === 0) {
		return scope === "compacted"
			? `No matches among the entries removed from the context. Search the whole branch with scope "all".`
			: "No matches in the current branch.";
	}
	const shown = hits.length < total ? `showing the ${hits.length} newest of ${total}` : `${total}`;
	const lines = [`${total === 1 ? "1 matching entry" : `${total} matching entries`} (${shown}; newest first):`];
	for (const hit of hits) {
		const meta = [utcMinute(hit.at), hit.label, `${hit.matches} match${hit.matches === 1 ? "" : "es"}`];
		if (hit.inContext) meta.push("in context");
		lines.push("", `[${hit.id}] ${meta.join(" · ")}`, `  ${hit.snippet}`);
	}
	lines.push("", `Read an entry in full with ${RECALL_TOOL_NAME} entryId=<id>.`);
	return lines.join("\n");
}

/** Byte budget of the text of one page: the tool output is cut at pi's 50 KB, which would drop the footer with the next offset. */
export const MAX_PAGE_BYTES = 45_000;

/** The largest `end` in `start..end` such that `text.slice(start, end)` takes at most `maxBytes` in UTF-8 (never splits a surrogate pair). */
function fitBytes(text: string, start: number, end: number, maxBytes: number): number {
	let bytes = 0;
	let i = start;
	while (i < end) {
		const cp = text.codePointAt(i) ?? 0;
		const size = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
		if (bytes + size > maxBytes) break;
		bytes += size;
		i += cp > 0xffff ? 2 : 1;
	}
	return i;
}

/** One page of an entry: a heading, up to `maxChars` of its text from `offset`, and how to get the next page. */
export function renderEntryPage(content: EntryText, offset = 0, maxChars?: number): string {
	const size = clamp(maxChars, MIN_PAGE_CHARS, MAX_PAGE_CHARS, DEFAULT_PAGE_CHARS);
	const total = content.text.length;
	const heading = `${content.kind} · ${utcMinute(content.at)} · ${content.label}`;
	const start = clamp(offset, 0, Number.MAX_SAFE_INTEGER, 0);
	if (start >= total && total > 0) return `${heading}\n\n[offset ${start} is past the end: the entry has ${total} chars]`;

	const end = fitBytes(content.text, start, Math.min(start + size, total), MAX_PAGE_BYTES);
	const footer = end < total ? `[chars ${start}–${end} of ${total}; call again with offset=${end}]` : `[chars ${start}–${end} of ${total}; end of entry]`;
	return `${heading}\n\n${content.text.slice(start, end)}\n\n${footer}`;
}
