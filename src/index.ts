import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { BoundaryResult, CompactionEntry, ExtensionAPI, ExtensionContext, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { readPrevious, recordBudgetChars } from "./checkpoint.ts";
import { type AutocompactState, registerAutocompactCommand } from "./command.ts";
import { loadConfig, readKeepRecentTokens } from "./config.ts";
import { modelKey } from "./model.ts";
import { Precomputer, type Snapshot, aheadKeep, compactAt, createSnapshot, growthFor, inLeadWindow, leadFor, validateSnapshot } from "./precompute.ts";
import { RECALL_TOOL_NAME } from "./recall.ts";
import { registerRecallTool } from "./recall-tool.ts";
import { RESUME_MESSAGE, ResumeGuard } from "./resume.ts";
import { planSpan } from "./span.ts";
import { type Built, type SummarySettings, assembleCheckpoint, buildCheckpoint, generateStateWithRetry, settingsKey } from "./summarize.ts";

const seconds = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
// A wait shorter than this is reported as "no wait".
const NO_WAIT_MS = 500;
const DISCARDED_ENTRY = "auto-compact-discarded";
const RESUME_ENTRY = "auto-compact-resume";

export default function (pi: ExtensionAPI) {
	const config = loadConfig();
	const state: AutocompactState = {
		percent: config.percent,
		enabled: true,
		summarizerKey: config.model,
		thinking: config.thinking,
		precompute: config.precompute,
		recall: config.recall,
	};
	// Context size measured on the first response after the latest compaction (null until then).
	let baseline: number | null = null;
	let awaitingBaseline = false;
	const guard = new ResumeGuard();
	const precomputer = new Precomputer();

	if (config.recall) registerRecallTool(pi);
	// Name of the recall tool when it is registered and active (an allowlist may leave it out); the checkpoint points to it.
	const recallToolName = (): string | undefined => (config.recall && pi.getActiveTools().includes(RECALL_TOOL_NAME) ? RECALL_TOOL_NAME : undefined);

	const thresholdFor = (contextWindow: number) =>
		Math.max(Math.floor((contextWindow * state.percent) / 100), config.minTokens);
	const recordBudgetFor = (ctx: ExtensionContext) => recordBudgetChars(thresholdFor(ctx.model?.contextWindow ?? 128_000));
	const summarySettings = (): SummarySettings => ({
		summarizerKey: state.summarizerKey,
		thinking: state.thinking,
		sessionThinking: pi.getThinkingLevel(),
	});
	const notify = (ctx: ExtensionContext, msg: string, level: "info" | "warning" | "error" = "info") => {
		if (ctx.hasUI) ctx.ui.notify(msg, level);
	};
	const compacted = () => {
		baseline = null;
		awaitingBaseline = true;
	};

	registerAutocompactCommand(pi, { state, precomputer, thresholdFor, notify });

	// Compaction at the turn boundary. The checkpoint is appended through the boundary result instead of
	// ctx.compact(): ctx.compact() aborts the running agent and never resumes it, while a boundary entry is
	// applied in place and the agent simply carries on with the compacted context on its next request.
	pi.on("turn_end", async (event, ctx) => {
		guard.turnEnded(event.toolResults.length);
		const result = await compactAtBoundary(event, ctx);
		// What the background jobs that were thrown away cost: plain entries, appended at the boundary (an
		// appendEntry in the middle of a turn could land between a tool call and its result).
		const discarded = precomputer.drainDiscarded();
		if (discarded.length === 0) return result;
		return {
			...result,
			entries: [
				...(result?.entries ?? event.entries),
				...discarded.map(({ usage, reason, model }) => ({ type: "custom" as const, customType: DISCARDED_ENTRY, data: { reason, model, usage } })),
			],
		};
	});

	async function compactAtBoundary(event: TurnEndEvent, ctx: ExtensionContext): Promise<BoundaryResult | undefined> {
		if (!state.enabled || event.outcome !== "completed") return;
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens == null || !usage.contextWindow) return;

		if (awaitingBaseline) {
			baseline = usage.tokens;
			awaitingBaseline = false;
			return;
		}
		const threshold = thresholdFor(usage.contextWindow);
		const growth = growthFor(threshold);
		const trigger = compactAt(threshold, baseline, growth);
		const model = ctx.model ? modelKey(ctx.model) : undefined;
		let keepRecentTokens: number | undefined; // reads the settings files: once per turn
		const keepRecent = () => (keepRecentTokens ??= readKeepRecentTokens(ctx.cwd, model, ctx.isProjectTrusted()));
		const entries = event.context.contextEntries;
		// The kept tail may exceed `keepRecent` by `lead` (at least `keepRecent` itself): a snapshot is not worth
		// throwing away because one big turn landed after it was prepared; the extra tail simply stays verbatim.
		const validate = (snapshot: Snapshot) =>
			validateSnapshot(snapshot, entries, {
				settingsKey: settingsKey(ctx, summarySettings()),
				keepRecent: keepRecent(),
				lead: Math.max(leadFor(growth), keepRecent()),
				estimate: estimateTokens,
			});

		if (usage.tokens <= trigger) {
			if (state.precompute) maintainPrecompute(ctx, { entries, tokens: usage.tokens, growth, trigger, keepRecent: keepRecent(), validate });
			return;
		}

		const warnDiscarded = (reason: string) => notify(ctx, `Auto-compact: the background summary was discarded (${reason}); summarizing now`, "warning");
		let announced = false;
		const announce = () => {
			announced = true;
			notify(ctx, `Auto-compact: ${usage.tokens} tokens > threshold ${threshold} (${state.percent}%), compacting without stopping the agent`);
			if (ctx.hasUI) ctx.ui.setWorkingMessage("Compacting context…");
		};
		const appended = (built: Built, firstKeptEntryId: string): BoundaryResult => {
			compacted();
			guard.compacted();
			precomputer.cycleReset();
			return {
				entries: [
					...event.entries,
					{ type: "compaction" as const, summary: built.summary, firstKeptEntryId, details: built.details, usage: built.usage },
				],
			};
		};

		try {
			if (state.precompute) {
				const adopted = await precomputer.adopt(validate, ctx.signal, announce);
				if (adopted.status === "aborted") return;
				if (adopted.status === "discarded") warnDiscarded(adopted.reason);
				if (adopted.status === "adopted") {
					const { taken } = adopted;
					const built = assembleCheckpoint({
						sessionFile: ctx.sessionManager.getSessionFile(),
						messages: taken.snapshot.messages,
						previous: taken.snapshot.previous,
						generated: taken.generated,
						recordBudgetChars: recordBudgetFor(ctx),
						recallTool: recallToolName(),
					});
					if (built.note) notify(ctx, `Auto-compact: ${built.note}`, "warning");
					const timing = taken.waitedMs < NO_WAIT_MS ? "no wait" : `waited ${seconds(taken.waitedMs)}`;
					notify(ctx, `Auto-compact: background summary adopted (prepared in ${seconds(taken.preparedMs)} · ${timing})`);
					return appended(built, taken.snapshot.firstKeptEntryId);
				}
			}

			const span = planSpan(entries, keepRecent(), estimateTokens);
			if (!span) return;
			if (!announced) announce();
			const built = await buildCheckpoint({
				ctx,
				messages: span.messages,
				previous: span.previous,
				signal: ctx.signal,
				...summarySettings(),
				recordBudgetChars: recordBudgetFor(ctx),
				recallTool: recallToolName(),
			});
			if (built.note) notify(ctx, `Auto-compact: ${built.note}`, "warning");
			if (built.degraded) notify(ctx, `Auto-compact: model summary failed (${built.degraded}); used the deterministic fallback`, "warning");
			return appended(built, span.firstKeptEntryId);
		} catch (error) {
			if (ctx.signal?.aborted) return;
			baseline = usage.tokens; // retry only after the context has grown further
			notify(ctx, `Auto-compact failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		} finally {
			if (announced && ctx.hasUI) ctx.ui.setWorkingMessage();
		}
	}

	/** Below the trigger: drop a job whose snapshot no longer fits, and start one when the context is close enough. */
	function maintainPrecompute(
		ctx: ExtensionContext,
		{ entries, tokens, growth, trigger, keepRecent, validate }: {
			entries: TurnEndEvent["context"]["contextEntries"];
			tokens: number;
			growth: number;
			trigger: number;
			keepRecent: number;
			validate: (snapshot: Snapshot) => ReturnType<typeof validateSnapshot>;
		},
	): void {
		try {
			precomputer.dropIfInvalid(validate);
			if (!precomputer.canStart || !inLeadWindow(tokens, trigger, growth)) return;
			const settings = summarySettings();
			const snapshot = createSnapshot(entries, {
				keep: aheadKeep(keepRecent, tokens, trigger),
				estimate: estimateTokens,
				settingsKey: settingsKey(ctx, settings),
			});
			if (!snapshot) return;
			precomputer.start(snapshot, (snap, signal) =>
				generateStateWithRetry({
					ctx,
					messages: snap.messages,
					previousState: readPrevious(snap.previous).state,
					signal,
					...settings,
				}),
			);
		} catch (error) {
			notify(ctx, `Auto-compact: background summary not started (${error instanceof Error ? error.message : String(error)})`, "warning");
		}
	}

	pi.on("agent_start", () => guard.reset());

	// If the agent goes quiet right after a compaction, ask it to carry on (once).
	// Triggered by structure (a text-only turn right after a compaction), not by wording; replies that
	// hand the conversation back to the user are left alone.
	pi.on("agent_before_settle", (event) => {
		const last = event.context.contextMessages.at(-1);
		if (last?.role !== "assistant") return guard.reset();
		const reply = last.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
		if (!guard.shouldResume(event.outcome, reply) || !state.enabled || !config.resume) return;
		return {
			entries: [
				...event.entries,
				{ type: "custom_message" as const, customType: RESUME_ENTRY, content: RESUME_MESSAGE, display: true },
			],
			continue: true,
		};
	});

	// Any compaction (manual /compact, pi's own threshold/overflow safety net) gets the same checkpoint,
	// so what is recorded and carried forward stays consistent across compactions.
	pi.on("session_before_compact", async (event, ctx) => {
		// manual (with focus), overflow and pi's own threshold compactions are computed fresh, never from a snapshot
		precomputer.discard("pi compaction");
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
				...summarySettings(),
				recordBudgetChars: recordBudgetFor(ctx),
				recallTool: recallToolName(),
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

	// Whatever was prepared no longer matches the branch after a compaction, a /tree move, a model or thinking
	// change, or the end of the session (this also aborts the model call of a running job).
	pi.on("session_compact", () => {
		compacted();
		precomputer.cycleReset();
	});
	pi.on("session_tree", () => precomputer.discard("session tree navigation"));
	pi.on("model_select", () => precomputer.discard("active model changed"));
	pi.on("thinking_level_select", () => {
		if (state.thinking === "session") precomputer.discard("session thinking level changed");
	});
	pi.on("session_shutdown", () => precomputer.discard("session shutdown"));
}
