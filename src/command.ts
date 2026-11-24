import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isValidPercent, saveConfig } from "./config.ts";
import {
	THINKING_LEVELS,
	type ThinkingChoice,
	findConfiguredModel,
	isThinkingChoice,
	modelKey,
	resolveThinking,
} from "./model.ts";
import type { Precomputer } from "./precompute.ts";

const ACTIVE_MODEL_LABEL = "Active model (default)";
const TOP_LEVEL = ["status", "on", "off", "model", "think", "precompute"] as const;

const formatWindow = (tokens: number) =>
	tokens >= 1_000_000 ? `${Number((tokens / 1_000_000).toFixed(2))}M` : `${Math.round(tokens / 1_000)}K`;

export interface AutocompactState {
	percent: number;
	enabled: boolean;
	/** Model that writes the summaries (`provider/id`); undefined = the active model. */
	summarizerKey?: string;
	/** Thinking level of that model; undefined = off. */
	thinking?: ThinkingChoice;
	/** Background summary (opt-in): write the state while the agent works. */
	precompute: boolean;
	/** Whether `session_recall` was enabled in config. */
	readonly recall: boolean;
}

export interface CommandDeps {
	state: AutocompactState;
	precomputer: Precomputer;
	thresholdFor: (contextWindow: number) => number;
	notify: (ctx: ExtensionContext, msg: string, level?: "info" | "warning" | "error") => void;
}

/** Register `/autocompact` and keep its model-completion list fresh across sessions. */
export function registerAutocompactCommand(pi: ExtensionAPI, { state, precomputer, thresholdFor, notify }: CommandDeps): void {
	// Models with credentials, for argument completion.
	let availableModels: string[] = [];

	pi.on("session_start", (_event, ctx) => {
		availableModels = ctx.modelRegistry.getAvailable().map(modelKey).sort();
	});

	function persist(ctx: ExtensionCommandContext, patch: Parameters<typeof saveConfig>[0], label = "the choice"): void {
		const err = saveConfig(patch);
		if (err) notify(ctx, `Could not save ${label} (${err}); applies to this session only`, "error");
	}

	/** `off`, or `on (state)` with the reason the last job was dropped. */
	function precomputeLabel(): string {
		if (!state.precompute) return "off";
		const { state: jobState, lastDiscard } = precomputer.status();
		return `on (${jobState}${lastDiscard ? `; last dropped: ${lastDiscard}` : ""})`;
	}

	/** `/autocompact model [provider/id|default]`: no argument opens a menu. */
	async function chooseModel(ctx: ExtensionCommandContext, requested: string): Promise<void> {
		const available = ctx.modelRegistry.getAvailable();
		availableModels = available.map(modelKey).sort();
		let choice: string | null | undefined; // null = active model, undefined = cancelled
		let fromMenu = false;

		if (!requested) {
			if (!ctx.hasUI) {
				notify(ctx, `Summaries: ${state.summarizerKey ?? "active model"}. Set with /autocompact model <provider/id|default>`);
				return;
			}
			const options = new Map<string, string | null>([[`${state.summarizerKey ? "" : "✓ "}${ACTIVE_MODEL_LABEL}`, null]]);
			for (const model of [...available].sort((a, b) => modelKey(a).localeCompare(modelKey(b)))) {
				const key = modelKey(model);
				options.set(`${key === state.summarizerKey ? "✓ " : ""}${key}  (${formatWindow(model.contextWindow)} context)`, key);
			}
			const picked = await ctx.ui.select("Model that writes the auto-compact summaries", [...options.keys()]);
			if (picked === undefined) return;
			choice = options.get(picked);
			fromMenu = true;
		} else if (["default", "active", "reset"].includes(requested.toLowerCase())) {
			choice = null;
		} else {
			const found = findConfiguredModel(ctx.modelRegistry, requested);
			if (!found) {
				notify(ctx, `Unknown model or no credentials: ${requested}. Run /autocompact model to pick one.`, "error");
				return;
			}
			choice = modelKey(found);
		}
		if (choice === undefined) return;

		state.summarizerKey = choice ?? undefined;
		precomputer.discard("summary model changed");
		persist(ctx, { model: choice });
		notify(ctx, `Auto-compact summaries will be written by ${state.summarizerKey ?? "the active model"}`);
		// The supported levels depend on the model, so offer the thinking menu right after picking one.
		if (fromMenu) await chooseThinking(ctx, "", true);
	}

	/** `/autocompact think [level|session|default]`: no argument opens a menu of the levels the summary model supports. */
	async function chooseThinking(ctx: ExtensionCommandContext, requested: string, chained = false): Promise<void> {
		const model = findConfiguredModel(ctx.modelRegistry, state.summarizerKey) ?? ctx.model;
		const supported = model ? getSupportedThinkingLevels(model) : ["off" as const];
		const session = pi.getThinkingLevel();
		let choice: ThinkingChoice | null | undefined; // null = off (default), undefined = cancelled

		if (!requested) {
			const current = state.thinking ?? "off";
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

		state.thinking = choice ?? undefined;
		precomputer.discard("summary thinking changed");
		persist(ctx, { thinking: choice });
		const wanted = state.thinking === "session" ? session : (state.thinking ?? "off");
		const effective = resolveThinking(state.thinking, session, supported);
		const clamp = effective === wanted || !model ? "" : ` (${modelKey(model)} does not support "${wanted}"; it will use "${effective}")`;
		notify(ctx, `Auto-compact summaries will use thinking: ${state.thinking ?? "off"}${clamp}`);
	}

	function getArgumentCompletions(prefix: string) {
		const match = /^(\S+)\s+(.*)$/.exec(prefix);
		if (!match) {
			const lower = prefix.toLowerCase();
			const items = TOP_LEVEL.filter((s) => s.startsWith(lower)).map((s) => ({ value: s, label: s }));
			return items.length > 0 ? items : null;
		}
		const sub = match[1].toLowerCase();
		const rest = match[2];
		const specs: Record<string, { candidates: readonly string[]; caseSensitive?: boolean }> = {
			model: { candidates: ["default", ...availableModels], caseSensitive: true },
			think: { candidates: ["default", "session", ...THINKING_LEVELS] },
			precompute: { candidates: ["on", "off"] },
		};
		const spec = specs[sub];
		if (!spec) return null;
		const needle = spec.caseSensitive ? rest : rest.toLowerCase();
		const items = spec.candidates.filter((c) => c.startsWith(needle)).map((c) => ({ value: `${sub} ${c}`, label: c }));
		return items.length > 0 ? items : null;
	}

	pi.registerCommand("autocompact", {
		description: "Auto-compact: /autocompact [percent|on|off|status|model|think|precompute]",
		getArgumentCompletions,
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const [first = "", ...rest] = trimmed ? trimmed.split(/\s+/) : [];
			const sub = first.toLowerCase();

			if (sub === "model") {
				await chooseModel(ctx, rest.join(" "));
				return;
			}
			if (sub === "think") {
				await chooseThinking(ctx, rest.join(" "));
				return;
			}
			if (sub === "precompute") {
				if (rest.length === 1 && (rest[0].toLowerCase() === "on" || rest[0].toLowerCase() === "off")) {
					state.precompute = rest[0].toLowerCase() === "on";
					if (state.precompute) precomputer.resume();
					else precomputer.discard("precompute turned off");
					persist(ctx, { precompute: state.precompute });
				} else if (rest.length > 0) {
					notify(ctx, "Usage: /autocompact precompute [on|off]", "error");
					return;
				}
			} else if (sub === "off" && rest.length === 0) {
				state.enabled = false;
				precomputer.discard("auto-compact turned off");
			} else if (sub === "on" && rest.length === 0) {
				state.enabled = true;
			} else if ((sub !== "" && sub !== "status") || rest.length > 0) {
				const n = rest.length === 0 ? Number(sub.replace(/%$/, "")) : Number.NaN;
				if (!isValidPercent(n)) {
					notify(ctx, "Usage: /autocompact [1-99|on|off|status|model|think|precompute]", "error");
					return;
				}
				state.percent = n;
				state.enabled = true;
				precomputer.discard("threshold changed");
				persist(ctx, { percent: n }, "default");
			}

			const usage = ctx.getContextUsage();
			const window = usage?.contextWindow ?? 0;
			const detail = window ? ` (threshold ${thresholdFor(window)} of ${window} tokens)` : "";
			notify(
				ctx,
				`Auto-compact ${state.enabled ? "ON" : "OFF"} at ${state.percent}%${detail}; summaries by ${state.summarizerKey ?? "the active model"}, thinking ${state.thinking ?? "off"}, recall ${state.recall ? "on" : "off"}, precompute ${precomputeLabel()}`,
			);
		},
	});
}
