import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	DEFAULT_KEEP_RECENT_TOKENS,
	DEFAULT_MIN_TOKENS,
	DEFAULT_PERCENT,
	isValidPercent,
	loadConfig,
	readKeepRecentTokens,
	saveConfig,
} from "../src/config.ts";

const agentDir = mkdtempSync(join(tmpdir(), "ac-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const write = (path: string, value: unknown) => {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(value));
};

test("loadConfig falls back to defaults, then reads valid values only", () => {
	assert.deepEqual(loadConfig(), { percent: DEFAULT_PERCENT, minTokens: DEFAULT_MIN_TOKENS, resume: true, recall: true, precompute: false, model: undefined, thinking: undefined });
	write(join(agentDir, "auto-compact.json"), { percent: 15, minTokens: 5000, resume: false, recall: false, precompute: true, model: "anthropic/claude-haiku-5-5", thinking: "low" });
	assert.deepEqual(loadConfig(), { percent: 15, minTokens: 5000, resume: false, recall: false, precompute: true, model: "anthropic/claude-haiku-5-5", thinking: "low" });
	write(join(agentDir, "auto-compact.json"), { thinking: "session" });
	assert.equal(loadConfig().thinking, "session");
	write(join(agentDir, "auto-compact.json"), { percent: 150, minTokens: -1, resume: "no", recall: "no", precompute: "yes", model: "nope", thinking: "loud" });
	assert.deepEqual(loadConfig(), { percent: DEFAULT_PERCENT, minTokens: DEFAULT_MIN_TOKENS, resume: true, recall: true, precompute: false, model: undefined, thinking: undefined });
});

test("precompute is opt-in: only an explicit true enables it", () => {
	const file = join(agentDir, "auto-compact.json");
	for (const value of [false, 1, "true", null, [true]]) {
		write(file, { precompute: value });
		assert.equal(loadConfig().precompute, false, JSON.stringify(value));
	}
	write(file, { precompute: true });
	assert.equal(loadConfig().precompute, true);
});

test("saveConfig keeps the other keys, sets the model and removes it with null", () => {
	const file = join(agentDir, "auto-compact.json");
	const read = () => JSON.parse(readFileSync(file, "utf8"));
	write(file, { minTokens: 5000 });
	assert.equal(saveConfig({ percent: 12 }), undefined);
	assert.deepEqual(read(), { minTokens: 5000, percent: 12 });
	assert.equal(saveConfig({ model: "anthropic/claude-haiku-5-5" }), undefined);
	assert.deepEqual(read(), { minTokens: 5000, percent: 12, model: "anthropic/claude-haiku-5-5" });
	assert.equal(saveConfig({ model: null }), undefined);
	assert.deepEqual(read(), { minTokens: 5000, percent: 12 });
	assert.equal(saveConfig({ thinking: "high" }), undefined);
	assert.deepEqual(read(), { minTokens: 5000, percent: 12, thinking: "high" });
	assert.equal(saveConfig({ thinking: null }), undefined);
	assert.deepEqual(read(), { minTokens: 5000, percent: 12 });
	assert.equal(saveConfig({ precompute: true }), undefined);
	assert.deepEqual(read(), { minTokens: 5000, percent: 12, precompute: true });
	assert.equal(saveConfig({ precompute: false }), undefined);
	assert.deepEqual(read(), { minTokens: 5000, percent: 12, precompute: false });
});

test("isValidPercent", () => {
	assert.ok(isValidPercent(1) && isValidPercent(99.5));
	assert.ok(!isValidPercent(0) && !isValidPercent(100) && !isValidPercent(Number.NaN) && !isValidPercent("5"));
});

test("readKeepRecentTokens: default, global, project, model override precedence", () => {
	const project = mkdtempSync(join(tmpdir(), "ac-project-"));
	assert.equal(readKeepRecentTokens(project, "p/m", true), DEFAULT_KEEP_RECENT_TOKENS);

	write(join(agentDir, "settings.json"), { compaction: { keepRecentTokens: 30_000, modelOverrides: { "p/m": { keepRecentTokens: 50_000 } } } });
	assert.equal(readKeepRecentTokens(project, "other/x", true), 30_000);
	assert.equal(readKeepRecentTokens(project, "p/m", true), 50_000);

	// project overrides the ordinary global value, but a global model override still beats a project-wide one
	write(join(project, ".pi", "settings.json"), { compaction: { keepRecentTokens: 10_000 } });
	assert.equal(readKeepRecentTokens(project, "other/x", true), 10_000);
	assert.equal(readKeepRecentTokens(project, "p/m", true), 50_000);

	// an untrusted project is ignored
	assert.equal(readKeepRecentTokens(project, "other/x", false), 30_000);

	// invalid values fall through
	write(join(agentDir, "settings.json"), { compaction: { keepRecentTokens: "lots" } });
	assert.equal(readKeepRecentTokens(project, "other/x", false), DEFAULT_KEEP_RECENT_TOKENS);
});
