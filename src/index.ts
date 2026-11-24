import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { CompactionEntry, ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { recordBudgetChars } from "./checkpoint.ts";
import { isValidPercent, loadConfig, readKeepRecentTokens, saveConfig } from "./config.ts";
import { THINKING_LEVELS, type ThinkingChoice, isThinkingChoice, modelKey, parseModelKey, resolveThinking } from "./model.ts";
import { growthFor } from "./precompute.ts";
import { RESUME_MESSAGE, ResumeGuard } from "./resume.ts";
import { RECALL_TOOL_NAME } from "./recall.ts";
import { registerRecallTool } from "./recall-tool.ts";
import { planSpan } from "./span.ts";
import { buildCheckpoint } from "./summarize.ts";

const ACTIVE_MODEL_LABEL = "Active model (default)";

const formatWindow = (tokens: number) =>
	tokens >= 1_000_000 ? `${Number((tokens / 1_000_000).toFixed(2))}M` : `${Math.round(tokens / 1_000)}K`;

export default function (pi: ExtensionAPI) {
	const config = loadConfig();
	let percent = config.percent;
	let enabled = true;
	// Model that writes the summaries (`provider/id`); undefined = the active model.
	let summarizerKey = config.model;
	// Thinking level of that model; undefined = off.
	let thinking = config.thinking;
	// Models with credentials, for argument completion.
	let availableModels: string[] = [];
	// Context size measured on the first response after the latest compaction (null until then).
	let baseline: number | null = null;
	let awaitingBaseline = false;
	const guard = new ResumeGuard();
	// Name of the recall tool when registered; the checkpoint points to it.
	const recallTool = config.recall ? RECALL_TOOL_NAME : undefined;
	if (config.recall) registerRecallTool(pi);

	const thresholdFor = (contextWindow: number) =>
		Math.max(Math.floor((contextWindow * percent) / 100), config.minTokens);
	const recordBudgetFor = (ctx: ExtensionContext) => recordBudgetChars(thresholdFor(ctx.model?.contextWindow ?? 128_000));

	const notify = (ctx: ExtensionContext, msg: string, level: "info" | "warning" | "error" = "info") => {
		if (ctx.hasUI) ctx.ui.notify(msg, level);
	};
	const compacted = () => {
		baseline = null;
		awaitingBaseline = true;
	};

	pi.on("session_start", (_event, ctx) => {
		availableModels = ctx.modelRegistry.getAvailable().map(modelKey).sort();
	});

	// Compaction at the turn boundary. The checkpoint is appended through the boundary result instead of
	// ctx.compact(): ctx.compact() aborts the running agent and never resumes it, while a boundary entry is
	// applied in place and the agent simply carries on with the compacted context on its next request.
	pi.on("turn_end", async (event, ctx) => {
		guard.turnEnded(event.toolResults.length);
		if (!enabled || event.outcome !== "completed") return;
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens == null || !usage.contextWindow) return;

		if (awaitingBaseline) {
			baseline = usage.tokens;
			awaitingBaseline = false;
			return;
		}
		const threshold = thresholdFor(usage.contextWindow);
		if (usage.tokens <= threshold) return;
		if (baseline !== null && usage.tokens - baseline < growthFor(threshold)) return;

		const model = ctx.model ? modelKey(ctx.model) : undefined;
		const span = planSpan(event.context.contextEntries, readKeepRecentTokens(ctx.cwd, model, ctx.isProjectTrusted()), estimateTokens);
		if (!span) return;

		notify(ctx, `Auto-compact: ${usage.tokens} tokens > threshold ${threshold} (${percent}%), compacting without stopping the agent`);
		if (ctx.hasUI) ctx.ui.setWorkingMessage("Compacting context…");
		try {
			const built = await buildCheckpoint({
				ctx,
				messages: span.messages,
				previous: span.previous,
				signal: ctx.signal,
				summarizerKey,
				thinking,
				sessionThinking: pi.getThinkingLevel(),
				recordBudgetChars: recordBudgetFor(ctx),
				recallTool,
			});
			if (built.note) notify(ctx, `Auto-compact: ${built.note}`, "warning");
			if (built.degraded) notify(ctx, `Auto-compact: model summary failed (${built.degraded}); used the deterministic fallback`, "warning");
			compacted();
			guard.compacted();
			return {
				entries: [
					...event.entries,
					{
						type: "compaction" as const,
						summary: built.summary,
						firstKeptEntryId: span.firstKeptEntryId,
						details: built.details,
						usage: built.usage,
					},
				],
			};
		} catch (error) {
			if (ctx.signal?.aborted) return;
			baseline = usage.tokens; // retry only after the context has grown further
			notify(ctx, `Auto-compact failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		} finally {
			if (ctx.hasUI) ctx.ui.setWorkingMessage();
		}
	});

	pi.on("agent_start", () => guard.reset());

	// If the agent goes quiet right after a compaction, ask it to carry on (once).
	// Triggered by structure (a text-only turn right after a compaction), not by wording; replies that
	// hand the conversation back to the user are left alone.
	pi.on("agent_before_settle", (event) => {
		const last = event.context.contextMessages.at(-1);
		if (last?.role !== "assistant") return guard.reset();
		const reply = last.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
		if (!guard.shouldResume(event.outcome, reply) || !enabled || !config.resume) return;
		return {
			entries: [
				...event.entries,
				{ type: "custom_message" as const, customType: "auto-compact-resume", content: RESUME_MESSAGE, display: true },
			],
			continue: true,
		};
	});

	// Any compaction (manual /compact, pi's own threshold/overflow safety net) gets the same checkpoint,
	// so what is recorded and carried forward stays consistent across compactions.
	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, branchEntries, customInstructions, signal } = event;
		const messages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
		if (messages.length === 0) return;
		const previous = branchEntries.findLast(
			(e): e is CompactionEntry => e.type === "compaction" && e.summary === preparation.previousSummary,
		);
		try {
			const built = await buildCheckpoint({
				ctx,
				messages,
				previous,
				focus: customInstructions,
				signal,
				summarizerKey,
				thinking,
				sessionThinking: pi.getThinkingLevel(),
				recordBudgetChars: recordBudgetFor(ctx),
				recallTool,
			});
			if (built.note) notify(ctx, `Compaction: ${built.note}`, "warning");
			if (built.degraded) notify(ctx, `Compaction: model summary failed (${built.degraded}); used the deterministic fallback`, "warning");
			return {
				compaction: {
					summary: built.summary,
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
					usage: built.usage,
					details: built.details,
				},
			};
		} catch (error) {
			if (!signal.aborted) notify(ctx, `Checkpoint failed (${error instanceof Error ? error.message : String(error)}); using pi's default summary`, "warning");
			// returning nothing lets pi write its default summary
		}
	});

	pi.on("session_compact", compacted);

	/** `/autocompact model [provider/id|default]`: no argument opens a menu. */
	async function chooseModel(ctx: ExtensionCommandContext, requested: string): Promise<void> {
		const available = ctx.modelRegistry.getAvailable();
		availableModels = available.map(modelKey).sort();
		let choice: string | null | undefined; // null = active model, undefined = cancelled
		let fromMenu = false;

		if (!requested) {
			if (!ctx.hasUI) {
				notify(ctx, `Summaries: ${summarizerKey ?? "active model"}. Set with /autocompact model <provider/id|default>`);
				return;
			}
			const options = new Map<string, string | null>([[`${summarizerKey ? "" : "✓ "}${ACTIVE_MODEL_LABEL}`, null]]);
			for (const model of [...available].sort((a, b) => modelKey(a).localeCompare(modelKey(b)))) {
				const key = modelKey(model);
				options.set(`${key === summarizerKey ? "✓ " : ""}${key}  (${formatWindow(model.contextWindow)} context)`, key);
			}
			const picked = await ctx.ui.select("Model that writes the auto-compact summaries", [...options.keys()]);
			if (picked === undefined) return;
			choice = options.get(picked);
			fromMenu = true;
		} else if (["default", "active", "reset"].includes(requested.toLowerCase())) {
			choice = null;
		} else {
			const parsed = parseModelKey(requested);
			const found = parsed ? ctx.modelRegistry.find(parsed.provider, parsed.id) : undefined;
			if (!found || !ctx.modelRegistry.hasConfiguredAuth(found)) {
				notify(ctx, `Unknown model or no credentials: ${requested}. Run /autocompact model to pick one.`, "error");
				return;
			}
			choice = modelKey(found);
		}
		if (choice === undefined) return;

		summarizerKey = choice ?? undefined;
		const err = saveConfig({ model: choice });
		if (err) notify(ctx, `Could not save the choice (${err}); applies to this session only`, "error");
		notify(ctx, `Auto-compact summaries will be written by ${summarizerKey ?? "the active model"}`);
		// The supported levels depend on the model, so offer the thinking menu right after picking one.
		if (fromMenu) await chooseThinking(ctx, "", true);
	}

	/** The model that will write the next summary: the configured one when usable, else the active one. */
	function summaryModel(ctx: ExtensionContext) {
		const parsed = summarizerKey ? parseModelKey(summarizerKey) : undefined;
		const found = parsed ? ctx.modelRegistry.find(parsed.provider, parsed.id) : undefined;
		return found && ctx.modelRegistry.hasConfiguredAuth(found) ? found : ctx.model;
	}

	/** `/autocompact think [level|session|default]`: no argument opens a menu of the levels the summary model supports. */
	async function chooseThinking(ctx: ExtensionCommandContext, requested: string, chained = false): Promise<void> {
		const model = summaryModel(ctx);
		const supported = model ? getSupportedThinkingLevels(model) : ["off" as const];
		const session = pi.getThinkingLevel();
		let choice: ThinkingChoice | null | undefined; // null = off (default), undefined = cancelled

		if (!requested) {
			const current = thinking ?? "off";
			if (!ctx.hasUI) {
				notify(ctx, `Summary thinking: ${current}. Set with /autocompact think <${THINKING_LEVELS.join("|")}|session|default>`);
				return;
			}
			if (supported.every((level) => level === "off")) {
				if (chained) return; // nothing to choose; the model notice above is enough
				notify(ctx, `${model ? modelKey(model) : "The summary model"} does not support thinking, so summaries run without it`);
				return;
			}
			const mark = (on: boolean) => (on ? "✓ " : "");
			const options = new Map<string, ThinkingChoice | null>([
				[`${mark(current === "off")}Off (default)`, null],
				[`${mark(current === "session")}Same as the session (now: ${session})`, "session"],
			]);
			for (const level of supported) if (level !== "off") options.set(`${mark(current === level)}${level}`, level);
			const picked = await ctx.ui.select(`Thinking for the auto-compact summaries (${model ? modelKey(model) : "no model"})`, [...options.keys()]);
			if (picked === undefined) return;
			choice = options.get(picked);
		} else if (requested.toLowerCase() === "default") {
			choice = null;
		} else if (isThinkingChoice(requested.toLowerCase())) {
			choice = requested.toLowerCase() as ThinkingChoice;
		} else {
			notify(ctx, `Usage: /autocompact think [${THINKING_LEVELS.join("|")}|session|default]`, "error");
			return;
		}
		if (choice === undefined) return;

		thinking = choice ?? undefined;
		const err = saveConfig({ thinking: choice });
		if (err) notify(ctx, `Could not save the choice (${err}); applies to this session only`, "error");
		const wanted = thinking === "session" ? session : (thinking ?? "off");
		const effective = resolveThinking(thinking, session, supported);
		const clamp = effective === wanted || !model ? "" : ` (${modelKey(model)} does not support "${wanted}"; it will use "${effective}")`;
		notify(ctx, `Auto-compact summaries will use thinking: ${thinking ?? "off"}${clamp}`);
	}

	pi.registerCommand("autocompact", {
		description: "Auto-compact: /autocompact [percent|on|off|status|model|think]",
		getArgumentCompletions: (prefix) => {
			const model = /^model\s+(.*)$/i.exec(prefix);
			const think = /^think\s+(.*)$/i.exec(prefix);
			const items = model
				? ["default", ...availableModels].filter((m) => m.startsWith(model[1])).map((m) => ({ value: `model ${m}`, label: m }))
				: think
					? ["default", "session", ...THINKING_LEVELS].filter((l) => l.startsWith(think[1].toLowerCase())).map((l) => ({ value: `think ${l}`, label: l }))
					: ["status", "on", "off", "model", "think"].filter((s) => s.startsWith(prefix.toLowerCase())).map((s) => ({ value: s, label: s }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const model = /^model(?:\s+(.*))?$/is.exec(args.trim());
			if (model) {
				await chooseModel(ctx, (model[1] ?? "").trim());
				return;
			}
			const think = /^think(?:\s+(.*))?$/is.exec(args.trim());
			if (think) {
				await chooseThinking(ctx, (think[1] ?? "").trim());
				return;
			}
			const arg = args.trim().toLowerCase();
			if (arg === "off") enabled = false;
			else if (arg === "on") enabled = true;
			else if (arg && arg !== "status") {
				const n = Number(arg.replace("%", ""));
				if (!isValidPercent(n)) {
					notify(ctx, "Usage: /autocompact [1-99|on|off|status|model|think]", "error");
					return;
				}
				percent = n;
				enabled = true;
				const err = saveConfig({ percent: n });
				if (err) notify(ctx, `Could not save default (${err}); applies to this session only`, "error");
			}
			const usage = ctx.getContextUsage();
			const window = usage?.contextWindow ?? 0;
			const detail = window ? ` (threshold ${thresholdFor(window)} of ${window} tokens)` : "";
			notify(ctx, `Auto-compact ${enabled ? "ON" : "OFF"} at ${percent}%${detail}; summaries by ${summarizerKey ?? "the active model"}, thinking ${thinking ?? "off"}, recall ${config.recall ? "on" : "off"}`);
		},
	});
}
