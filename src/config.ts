import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type ThinkingChoice, isThinkingChoice, parseModelKey } from "./model.ts";

export const DEFAULT_PERCENT = 20;
// Floor: with small windows a pure percentage would fall below the fixed prefix
// (system prompt + tools ~14k) and trigger compaction on every turn.
export const DEFAULT_MIN_TOKENS = 40_000;
// Same default as pi's `compaction.keepRecentTokens`.
export const DEFAULT_KEEP_RECENT_TOKENS = 20_000;

export interface Config {
	percent: number;
	minTokens: number;
	/** Ask the agent to continue when it goes quiet right after an auto-compaction. */
	resume: boolean;
	/** Register the `session_recall` tool (config file only). */
	recall: boolean;
	/** Write the state summary in the background before the compaction is due (opt-in: only `true` enables it). */
	precompute: boolean;
	/** `provider/id` of the model that writes the summaries; undefined = the active model. */
	model?: string;
	/** Thinking level of the summary model; undefined = off. */
	thinking?: ThinkingChoice;
}

// `/autocompact N` persists N here, so it becomes the new default for every session.
const configPath = () => join(getAgentDir(), "auto-compact.json");

export const isValidPercent = (n: unknown): n is number =>
	typeof n === "number" && Number.isFinite(n) && n > 0 && n < 100;
const isTokenCount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;

type Json = Record<string, unknown>;

function readJson(path: string): Json {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Json) : {};
	} catch {
		return {}; // missing or malformed: fall back to defaults
	}
}

export function loadConfig(): Config {
	const raw = readJson(configPath());
	return {
		percent: isValidPercent(raw.percent) ? raw.percent : DEFAULT_PERCENT,
		minTokens: isTokenCount(raw.minTokens) ? raw.minTokens : DEFAULT_MIN_TOKENS,
		resume: raw.resume !== false,
		recall: raw.recall !== false,
		precompute: raw.precompute === true,
		model: typeof raw.model === "string" && parseModelKey(raw.model) ? raw.model : undefined,
		thinking: isThinkingChoice(raw.thinking) ? raw.thinking : undefined,
	};
}

/** Persist settings, keeping any other keys; a `model` or `thinking` of null removes the key. Returns an error message on failure. */
export function saveConfig(patch: {
	percent?: number;
	model?: string | null;
	thinking?: ThinkingChoice | null;
	precompute?: boolean;
}): string | undefined {
	try {
		const next: Json = { ...readJson(configPath()) };
		if (patch.percent !== undefined) next.percent = patch.percent;
		if (patch.precompute !== undefined) next.precompute = patch.precompute;
		if (patch.model === null) delete next.model;
		else if (patch.model !== undefined) next.model = patch.model;
		if (patch.thinking === null) delete next.thinking;
		else if (patch.thinking !== undefined) next.thinking = patch.thinking;
		mkdirSync(getAgentDir(), { recursive: true });
		writeFileSync(configPath(), `${JSON.stringify(next, null, 2)}\n`);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

const asObject = (value: unknown): Json => (value && typeof value === "object" ? (value as Json) : {});

/**
 * pi's effective `compaction.keepRecentTokens`: the project file merges over the global one, and a
 * `modelOverrides["provider/id"]` value beats the ordinary setting (see pi's settings docs).
 */
export function readKeepRecentTokens(cwd: string, modelKey: string | undefined, projectTrusted: boolean): number {
	const files = [join(getAgentDir(), "settings.json")];
	if (projectTrusted) files.push(join(cwd, ".pi", "settings.json"));

	let model: unknown;
	let base: unknown;
	for (const file of files) {
		const compaction = asObject(readJson(file).compaction); // later files (project) win
		const override = modelKey ? asObject(asObject(compaction.modelOverrides)[modelKey]) : {};
		if (override.keepRecentTokens !== undefined) model = override.keepRecentTokens;
		if (compaction.keepRecentTokens !== undefined) base = compaction.keepRecentTokens;
	}
	for (const value of [model, base]) if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
	return DEFAULT_KEEP_RECENT_TOKENS;
}
