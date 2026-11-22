import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { chooseSummarizer, isThinkingChoice, modelKey, parseModelKey, resolveThinking } from "../src/model.ts";

const model = (provider: string, id: string, contextWindow: number) => ({ provider, id, contextWindow }) as unknown as Model<Api>;
const active = model("anthropic", "claude-sonnet-5-5", 1_000_000);
const cheap = model("anthropic", "claude-haiku-5-5", 200_000);

test("parseModelKey splits at the first slash and rejects malformed keys", () => {
	assert.deepEqual(parseModelKey("anthropic/claude-haiku-5-5"), { provider: "anthropic", id: "claude-haiku-5-5" });
	assert.deepEqual(parseModelKey("openrouter/meta/llama-4"), { provider: "openrouter", id: "meta/llama-4" });
	for (const bad of ["", "nope", "/x", "x/"]) assert.equal(parseModelKey(bad), undefined, bad);
});

test("modelKey round-trips with parseModelKey", () => {
	assert.equal(modelKey(cheap), "anthropic/claude-haiku-5-5");
	assert.deepEqual(parseModelKey(modelKey(cheap)), { provider: "anthropic", id: "claude-haiku-5-5" });
});

test("chooseSummarizer uses the active model when none is configured", () => {
	assert.deepEqual(chooseSummarizer(undefined, undefined, active, 50_000), { model: active });
});

test("chooseSummarizer uses the configured model when it fits", () => {
	assert.deepEqual(chooseSummarizer("anthropic/claude-haiku-5-5", cheap, active, 50_000), { model: cheap });
});

test("chooseSummarizer falls back to the active model, with a reason, when the model is unavailable", () => {
	const choice = chooseSummarizer("x/gone", undefined, active, 1_000);
	assert.equal(choice.model, active);
	assert.match(choice.note ?? "", /x\/gone is unavailable/);
});

test("chooseSummarizer falls back when the span does not fit the configured window", () => {
	const choice = chooseSummarizer("anthropic/claude-haiku-5-5", cheap, active, 250_000);
	assert.equal(choice.model, active);
	assert.match(choice.note ?? "", /too small/);
});

test("isThinkingChoice accepts pi's levels and \"session\" only", () => {
	for (const ok of ["off", "minimal", "low", "medium", "high", "xhigh", "max", "session"]) assert.ok(isThinkingChoice(ok), ok);
	for (const bad of ["", "High", "default", "on", 3, null, undefined]) assert.ok(!isThinkingChoice(bad), String(bad));
});

const levels = (...l: ModelThinkingLevel[]) => l;
const full = levels("off", "minimal", "low", "medium", "high");

test("resolveThinking: no choice means off; a supported level is used as is", () => {
	assert.equal(resolveThinking(undefined, "high", full), "off");
	assert.equal(resolveThinking("off", "high", full), "off");
	assert.equal(resolveThinking("medium", "off", full), "medium");
});

test("resolveThinking: \"session\" follows the session level", () => {
	assert.equal(resolveThinking("session", "low", full), "low");
	assert.equal(resolveThinking("session", "off", full), "off");
	assert.equal(resolveThinking("session", "nonsense", full), "off");
});

test("resolveThinking: an unsupported level goes to the nearest higher one, then the nearest lower", () => {
	assert.equal(resolveThinking("minimal", "off", levels("off", "low", "high")), "low");
	assert.equal(resolveThinking("max", "off", full), "high");
	assert.equal(resolveThinking("off", "off", levels("low", "high")), "low"); // a model that always thinks
});

test("resolveThinking: a model without thinking always gets off", () => {
	assert.equal(resolveThinking("high", "high", levels("off")), "off");
	assert.equal(resolveThinking("high", "high", []), "off");
});
