import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Automatically compacts when the context exceeds PERCENT of the active model's
// window (any model: the threshold is recomputed from its window).
const DEFAULT_PERCENT = 20;
// Floor: with small windows, 10% would fall below the fixed prefix
// (system prompt + tools ~14k) and trigger compaction on every turn.
const MIN_THRESHOLD_TOKENS = 40_000;

// `/autocompact N` persists N here, so it becomes the new default for every session.
const CONFIG_PATH = join(getAgentDir(), "auto-compact.json");

const isValidPercent = (n: unknown): n is number =>
	typeof n === "number" && Number.isFinite(n) && n > 0 && n < 100;

function loadPercent(): number {
	try {
		const { percent } = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
		if (isValidPercent(percent)) return percent;
	} catch {
		// missing or malformed config: fall back to the built-in default
	}
	return DEFAULT_PERCENT;
}

function savePercent(percent: number): string | undefined {
	try {
		mkdirSync(getAgentDir(), { recursive: true });
		writeFileSync(CONFIG_PATH, `${JSON.stringify({ percent }, null, 2)}\n`);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

export default function (pi: ExtensionAPI) {
	let percent = loadPercent();
	let enabled = true;
	let armed = true; // re-arms only once usage drops back below the threshold
	let compacting = false;

	const thresholdFor = (contextWindow: number) =>
		Math.max(Math.floor((contextWindow * percent) / 100), MIN_THRESHOLD_TOKENS);

	const notify = (ctx: ExtensionContext, msg: string, level: "info" | "error" = "info") => {
		if (ctx.hasUI) ctx.ui.notify(msg, level);
	};

	pi.on("turn_end", (_event, ctx) => {
		if (!enabled || compacting) return;
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens == null || !usage.contextWindow) return;

		const threshold = thresholdFor(usage.contextWindow);
		if (usage.tokens <= threshold) {
			armed = true;
			return;
		}
		if (!armed) return;

		armed = false;
		compacting = true;
		notify(ctx, `Auto-compact: ${usage.tokens} tokens > threshold ${threshold} (${percent}%)`);
		ctx.compact({
			onComplete: () => {
				compacting = false;
				notify(ctx, "Auto-compact completed");
			},
			onError: (error) => {
				compacting = false;
				armed = true; // retry on the next turn
				notify(ctx, `Auto-compact failed: ${error.message}`, "error");
			},
		});
	});

	pi.registerCommand("autocompact", {
		description: "Auto-compact: /autocompact [percent|on|off|status]",
		handler: (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "off") enabled = false;
			else if (arg === "on") enabled = true;
			else if (arg && arg !== "status") {
				const n = Number(arg.replace("%", ""));
				if (!Number.isFinite(n) || n <= 0 || n >= 100) {
					notify(ctx, "Usage: /autocompact [1-99|on|off|status]", "error");
					return;
				}
				percent = n;
				enabled = true;
				const err = savePercent(n);
				if (err) notify(ctx, `Could not save default (${err}); applies to this session only`, "error");
			}
			const usage = ctx.getContextUsage();
			const window = usage?.contextWindow ?? 0;
			const detail = window ? ` (threshold ${thresholdFor(window)} of ${window} tokens)` : "";
			notify(ctx, `Auto-compact ${enabled ? "ON" : "OFF"} at ${percent}%${detail}`);
		},
	});
}
