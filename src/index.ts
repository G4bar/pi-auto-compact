import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Compatta automaticamente quando il contesto supera PERCENT della finestra del
// modello attivo (qualunque modello: la soglia si ricalcola dalla sua finestra).
const DEFAULT_PERCENT = 10;
// Pavimento: con finestre piccole il 10% sarebbe sotto il prefisso fisso
// (system prompt + tool ~14k) e darebbe compaction a ogni turno.
const MIN_THRESHOLD_TOKENS = 40_000;

export default function (pi: ExtensionAPI) {
	let percent = DEFAULT_PERCENT;
	let enabled = true;
	let armed = true; // si riarma solo quando l'uso scende sotto soglia
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
		notify(ctx, `Auto-compact: ${usage.tokens} token > soglia ${threshold} (${percent}%)`);
		ctx.compact({
			onComplete: () => {
				compacting = false;
				notify(ctx, "Auto-compact completata");
			},
			onError: (error) => {
				compacting = false;
				armed = true; // riprova al prossimo turno
				notify(ctx, `Auto-compact fallita: ${error.message}`, "error");
			},
		});
	});

	pi.registerCommand("autocompact", {
		description: "Auto-compact: /autocompact [percentuale|on|off|status]",
		handler: (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "off") enabled = false;
			else if (arg === "on") enabled = true;
			else if (arg && arg !== "status") {
				const n = Number(arg.replace("%", ""));
				if (!Number.isFinite(n) || n <= 0 || n >= 100) {
					notify(ctx, "Uso: /autocompact [1-99|on|off|status]", "error");
					return;
				}
				percent = n;
				enabled = true;
			}
			const usage = ctx.getContextUsage();
			const window = usage?.contextWindow ?? 0;
			const detail = window ? ` (soglia ${thresholdFor(window)} token su ${window})` : "";
			notify(ctx, `Auto-compact ${enabled ? "ON" : "OFF"} al ${percent}%${detail}`);
		},
	});
}
