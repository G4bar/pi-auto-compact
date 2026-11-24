import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";

type AnyModel = Model<Api>;

/** Same order and names as pi's thinking levels. */
export const THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** A level, or "session" to follow the session's own thinking level (what pi's built-in summaries do). */
export type ThinkingChoice = ModelThinkingLevel | "session";

export const isThinkingChoice = (x: unknown): x is ThinkingChoice =>
	x === "session" || THINKING_LEVELS.includes(x as ModelThinkingLevel);

/**
 * The level to request from a model that supports `supported`: the chosen one, or the nearest supported
 * (higher first, then lower, as pi does). No choice means "off".
 */
export function resolveThinking(
	choice: ThinkingChoice | undefined,
	sessionLevel: string,
	supported: readonly ModelThinkingLevel[],
): ModelThinkingLevel {
	const wanted = choice === "session" ? sessionLevel : (choice ?? "off");
	const start = THINKING_LEVELS.indexOf(wanted as ModelThinkingLevel);
	if (start === -1) return "off";
	const candidates = [
		...THINKING_LEVELS.slice(start), // the level itself, then the higher ones
		...THINKING_LEVELS.slice(0, start).reverse(), // then the lower ones, nearest first
	];
	return candidates.find((level) => supported.includes(level)) ?? "off";
}

/** `provider/id`, where the id may itself contain slashes (e.g. openrouter models). */
export function parseModelKey(key: string): { provider: string; id: string } | undefined {
	const slash = key.indexOf("/");
	if (slash <= 0 || slash === key.length - 1) return undefined;
	return { provider: key.slice(0, slash), id: key.slice(slash + 1) };
}

export const modelKey = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;

export interface ModelLookup {
	find(provider: string, id: string): AnyModel | undefined;
	hasConfiguredAuth(model: AnyModel): boolean;
}

/** Look up `key` in `registry` and return the model only when it exists and has configured auth. */
export function findConfiguredModel(registry: ModelLookup, key: string | undefined): AnyModel | undefined {
	if (!key) return undefined;
	const parsed = parseModelKey(key);
	if (!parsed) return undefined;
	const found = registry.find(parsed.provider, parsed.id);
	return found && registry.hasConfiguredAuth(found) ? found : undefined;
}

export interface Summarizer {
	model: AnyModel;
	/** Why the configured model was not used, when it was not. */
	note?: string;
}

/**
 * Pick the model that writes the state summary: the one set with `/autocompact model` when it exists, has
 * credentials and its window fits the conversation to summarize, else the active model.
 */
export function chooseSummarizer(
	key: string | undefined,
	configured: AnyModel | undefined,
	active: AnyModel,
	neededTokens: number,
): Summarizer {
	if (!key) return { model: active };
	if (!configured) return { model: active, note: `summary model ${key} is unavailable (unknown or no credentials); used the active model` };
	if (configured.contextWindow < neededTokens) {
		return {
			model: active,
			note: `summary model ${key} has a ${configured.contextWindow}-token window, too small for this span (~${neededTokens}); used the active model`,
		};
	}
	return { model: configured };
}
