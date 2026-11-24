import { StringEnum } from "@earendil-works/pi-ai";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { RECALL_TOOL_NAME, buildToolCallIndex, entryText, renderEntryPage, renderHits, searchEntries } from "./recall.ts";

/** Final safety net: whatever the pages above allow, the tool output never exceeds pi's byte limit. */
function limitOutput(text: string): string {
	const cut = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: Number.MAX_SAFE_INTEGER });
	return cut.truncated ? `${cut.content}\n\n[output cut at ${formatSize(DEFAULT_MAX_BYTES)}; use a smaller maxChars]` : cut.content;
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text: limitOutput(text) }], details: {} });
const fail = (text: string) => ({ content: [{ type: "text" as const, text }], details: {}, isError: true });

/** Read-only tool that searches and re-reads the entries of the current branch, including compacted ones. */
export function registerRecallTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: RECALL_TOOL_NAME,
		label: "Session recall",
		description:
			"Search or re-read entries of this session that a compaction removed from the context. " +
			"With `query`: literal, case-insensitive search (newest first) returning entry ids and snippets; " +
			'`scope` is "compacted" (default: only entries no longer in context) or "all". ' +
			"With `entryId`: the full text of one entry (user message, assistant prose and tool calls, or a tool result with the call that produced it), paginated with `offset`/`maxChars`.",
		promptSnippet: "Search and re-read session entries removed by compaction (exact tool output, old messages)",
		promptGuidelines: [
			`Use ${RECALL_TOOL_NAME} after a context checkpoint to retrieve exact tool output or messages that were compacted away, instead of re-running commands or searching the session file.`,
		],
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Text to search for (literal, case-insensitive)" })),
			entryId: Type.Optional(Type.String({ description: "Id of the entry to read in full (from a search result)" })),
			scope: Type.Optional(StringEnum(["compacted", "all"] as const, { description: 'Search only entries removed from the context ("compacted", default) or the whole branch ("all")' })),
			limit: Type.Optional(Type.Number({ description: "Maximum search results (default 10, max 50)" })),
			offset: Type.Optional(Type.Number({ description: "Read: character offset to continue from (default 0)" })),
			maxChars: Type.Optional(Type.Number({ description: "Read: characters per page (default 12000, max 40000)" })),
		}),
		annotations: { readOnlyHint: true },
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const branch = ctx.sessionManager.getBranch();

			if (params.entryId !== undefined) {
				const id = params.entryId.trim();
				const entry = branch.find((e) => e.id === id);
				if (!entry) return fail(`No entry "${id}" in the current branch. Find ids with a search (query).`);
				const content = entryText(entry, buildToolCallIndex(branch));
				if (!content) return fail(`Entry "${id}" (${entry.type}) has no readable conversation text.`);
				return ok(renderEntryPage(content, params.offset, params.maxChars));
			}

			if (params.query === undefined) return fail("Pass `query` to search or `entryId` to read an entry.");
			const scope = params.scope === "all" ? "all" : "compacted"; // StringEnum's static type is not inferred by tsc here
			const visible = new Set(ctx.sessionManager.buildContextEntries().map((e) => e.id));
			const found = searchEntries(branch, visible, { query: params.query, scope, limit: params.limit });
			if (typeof found === "string") return fail(found);
			return ok(renderHits(found.hits, found.total, scope));
		},
	});
}
