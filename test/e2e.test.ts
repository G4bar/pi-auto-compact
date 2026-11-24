// End-to-end tests against the real pi SDK: createAgentSession + the extension + pi-ai's scripted (faux) provider.
//
// The faux provider is wired in through the documented ModelRuntime API (`fauxProvider()` +
// `modelRuntime.registerNativeProvider`), not through `registerFauxProvider` of pi-ai/compat: that one
// only fills the legacy global api-registry, which ModelRuntime does not read.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { AssistantMessage, FauxResponseStep } from "@earendil-works/pi-ai";
import {
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	createAgentSession,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	estimateTokens,
} from "@earendil-works/pi-coding-agent";
import type { AgentSession, AgentSessionRuntime, CompactionEntry, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";
import { aheadKeep, createSnapshot } from "../src/precompute.ts";
import { planSpan } from "../src/span.ts";

// Scale: window 50k at 20% = 10k threshold (growth 10k, lead 5k); pi's keepRecentTokens = 4k.
// Every `read` of big.txt adds ~1k tokens, so the context crosses the threshold after ~7 reads.
const THRESHOLD = 10_000;
const KEEP_RECENT = 4_000;
const STATE = "## Goal\nFAUX-STATE: the scripted summary of the conversation.";
const SUMMARY_SYSTEM_PROMPT = "You write context checkpoints";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const pending = () => {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => (resolve = r));
	return { promise, resolve };
};

interface SummaryRequest {
	/** Number of agent requests made before this one. */
	atAgentCall: number;
	signal?: AbortSignal;
	model: string;
}

interface Rig {
	session: AgentSession;
	runtime?: AgentSessionRuntime;
	/** Requests for a state summary (recognized by the system prompt of summarize.ts). */
	summaryRequests: SummaryRequest[];
	/** Number of agent (non-summary) requests so far. */
	agentCalls: () => number;
	/** Summary requests wait for this; resolve it to let them answer. Absent = answer at once. */
	gate: { current?: ReturnType<typeof pending> };
	/** Called with the number of agent requests made so far, before each agent request. */
	beforeAgentRequest: { current?: (calls: number) => Promise<void> | void };
	/** What the agent does next; see `scriptedAgent`. */
	policy: { current: (rig: Rig, context: unknown) => AssistantMessage };
	observed: {
		tokens: number[];
		shutdowns: string[];
		compacts: number;
		/** First turn_end where a context was captured by the observer. */
		ctx?: ExtensionContext;
		/** Context entries at each turn_end. */
		entries: unknown[][];
	};
	cleanup: () => Promise<void>;
}

const compactionEntries = (session: AgentSession) =>
	session.sessionManager.getBranch().filter((e): e is CompactionEntry => e.type === "compaction");

const toolCall = (name: string, args: Record<string, string>) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

/** Read big.txt until the first compaction, then `after`, then say "done". */
const scriptedAgent =
	(after: Array<(rig: Rig, context: unknown) => AssistantMessage | undefined> = []) =>
	(rig: Rig, context: unknown): AssistantMessage => {
		if (compactionEntries(rig.session).length === 0) return toolCall("read", { path: "big.txt" });
		for (const step of after) {
			const message = step(rig, context);
			if (message) return message;
		}
		return fauxAssistantMessage([fauxText("all done")]);
	};

async function createRig({ precompute, mode = "session" }: { precompute: boolean; mode?: "session" | "runtime" }): Promise<Rig> {
	const agentDir = mkdtempSync(join(tmpdir(), "ac-e2e-agent-"));
	const cwd = mkdtempSync(join(tmpdir(), "ac-e2e-cwd-"));
	process.env.PI_CODING_AGENT_DIR = agentDir; // read by the extension (auto-compact.json, keepRecentTokens)
	writeFileSync(join(agentDir, "auto-compact.json"), JSON.stringify({ percent: 20, minTokens: 1_000, precompute }));
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: KEEP_RECENT } }));
	writeFileSync(join(cwd, "a.txt"), `MARKER-A the very first output ${"alpha ".repeat(600)}\n`);
	writeFileSync(join(cwd, "big.txt"), `${"line of text ".repeat(300)}\n`);

	const faux = fauxProvider({ models: [{ id: "faux", contextWindow: 50_000, maxTokens: 8_000 }] });
	const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
	modelRuntime.registerNativeProvider(faux.provider);
	const model = modelRuntime.getModel("faux", "faux");
	assert.ok(model, "faux model registered");

	let agentCalls = 0;
	const rig = {
		summaryRequests: [],
		agentCalls: () => agentCalls,
		gate: {},
		beforeAgentRequest: {},
		policy: { current: scriptedAgent() },
		observed: { tokens: [], shutdowns: [], compacts: 0, entries: [] },
	} as unknown as Rig;

	// One router per scripted response: summary requests and agent requests share the faux queue, so each step
	// decides by what it is asked (the system prompt) instead of by its position.
	const router: FauxResponseStep = async (context, options, _state, requested) => {
		if (JSON.stringify(context.messages).includes(SUMMARY_SYSTEM_PROMPT)) {
			rig.summaryRequests.push({ atAgentCall: agentCalls, signal: options?.signal, model: requested.id });
			const gate = rig.gate.current;
			if (gate) {
				const aborted = new Promise<"aborted">((resolve) => options?.signal?.addEventListener("abort", () => resolve("aborted"), { once: true }));
				if ((await Promise.race([gate.promise, aborted])) === "aborted") return fauxAssistantMessage("", { stopReason: "aborted" });
			}
			return fauxAssistantMessage(STATE);
		}
		await rig.beforeAgentRequest.current?.(agentCalls);
		agentCalls++;
		return rig.policy.current(rig, context);
	};
	faux.setResponses(Array.from({ length: 60 }, () => router));

	const observer: ExtensionFactory = (pi) => {
		pi.on("turn_end", (event, ctx) => {
			rig.observed.ctx ??= ctx;
			rig.observed.tokens.push(ctx.getContextUsage()?.tokens ?? -1);
			rig.observed.entries.push([...event.context.contextEntries]);
		});
		pi.on("session_compact", () => void rig.observed.compacts++);
		pi.on("session_shutdown", (event) => void rig.observed.shutdowns.push(event.reason));
	};
	const extensionFactories = [extension, observer];

	if (mode === "session") {
		const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, extensionFactories });
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime,
			model,
			resourceLoader,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager: SettingsManager.create(cwd, agentDir),
		});
		rig.session = session;
	} else {
		const runtime = await createAgentSessionRuntime(
			async ({ cwd, sessionManager, sessionStartEvent }) => {
				const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime, resourceLoaderOptions: { extensionFactories } });
				return { ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model })), services, diagnostics: services.diagnostics };
			},
			{ cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) },
		);
		await runtime.session.bindExtensions({});
		rig.runtime = runtime;
		rig.session = runtime.session;
	}
	rig.cleanup = async () => {
		rig.gate.current?.resolve(); // never leave a model call hanging
		try {
			if (rig.runtime) await rig.runtime.dispose();
			else rig.session.dispose();
		} finally {
			modelRuntime.unregisterProvider("faux");
		}
	};
	return rig;
}

const assistantTexts = (session: AgentSession) =>
	session.messages.flatMap((m) => (m.role === "assistant" ? [m] : []));

/** Number of agent turns (assistant messages) that came before the compaction entry in the branch. */
const turnsBeforeCompaction = (session: AgentSession) => {
	const branch = session.sessionManager.getBranch();
	const at = branch.findIndex((e) => e.type === "compaction");
	return branch.slice(0, at).filter((e) => e.type === "message" && e.message.role === "assistant").length;
};

// ---------------------------------------------------------------------------------------------------

test("e2e: the compaction at turn_end is applied and the agent carries on without being aborted", async () => {
	const rig = await createRig({ precompute: false });
	try {
		await rig.session.prompt("read the files");

		const compactions = compactionEntries(rig.session);
		assert.equal(compactions.length, 1, "exactly one compaction entry in the branch");
		const [compaction] = compactions;
		const details = compaction.details as { checkpoint: { v: number; state: string } };
		assert.equal(details.checkpoint.v, 2);
		assert.match(details.checkpoint.state, /FAUX-STATE/);
		assert.match(compaction.summary, /FAUX-STATE/);
		assert.ok(rig.session.sessionManager.getBranch().some((e) => e.id === compaction.firstKeptEntryId), "firstKeptEntryId is in the branch");

		// no precompute: the summary is requested at the trigger, once
		assert.equal(rig.summaryRequests.length, 1);
		// the agent was not interrupted: it made more requests after the compaction and ended normally
		assert.ok(rig.agentCalls() > turnsBeforeCompaction(rig.session), "the agent kept requesting after the compaction");
		const last = assistantTexts(rig.session).at(-1);
		assert.equal(last?.stopReason, "stop");
		assert.ok(assistantTexts(rig.session).every((m) => m.stopReason !== "aborted" && m.stopReason !== "error"));
		assert.deepEqual(rig.observed.shutdowns, []);
		assert.equal(rig.observed.compacts, 0, "a boundary draft does not emit session_compact");
	} finally {
		await rig.cleanup();
	}
});

test("e2e: precompute — the summary request starts before the trigger and finishes in the background; adoption makes no new request", async () => {
	const rig = await createRig({ precompute: true });
	try {
		// Release the (initially held) summary a little later, while the agent keeps working: the job completes
		// from a turn_end ctx that has already returned.
		rig.gate.current = pending();
		let sinceStart = 0;
		rig.beforeAgentRequest.current = async () => {
			if (rig.summaryRequests.length > 0 && ++sinceStart === 2) {
				rig.gate.current?.resolve();
				await sleep(30); // let the job settle while the agent is paused mid-run
			}
		};
		const started = Date.now();
		await rig.session.prompt("read the files");
		assert.ok(Date.now() - started < 5_000);

		assert.equal(rig.summaryRequests.length, 1, "one summary request in total: none at adoption");
		const [request] = rig.summaryRequests;
		assert.equal(request.model, "faux", "the job used ctx.model / ctx.modelRegistry to reach the provider");
		const compaction = compactionEntries(rig.session)[0];
		assert.ok(compaction, "the compaction was applied");
		assert.match(compaction.summary, /FAUX-STATE/);
		assert.equal((compaction.details as { checkpoint: { v: number } }).checkpoint.v, 2);
		assert.ok(request.atAgentCall < turnsBeforeCompaction(rig.session), "the request started before the trigger turn");
		assert.ok(request.atAgentCall + 2 <= turnsBeforeCompaction(rig.session), "and completed while the agent kept working");

		// firstKeptEntryId is the snapshot's (planned when the job started), not a fresh plan at the trigger
		const startIndex = request.atAgentCall - 1; // the turn_end that started the job
		const entriesAtStart = rig.observed.entries[startIndex] as Parameters<typeof planSpan>[0];
		const tokensAtStart = rig.observed.tokens[startIndex];
		const snapshot = createSnapshot(entriesAtStart, { keep: aheadKeep(KEEP_RECENT, tokensAtStart, THRESHOLD), estimate: estimateTokens, settingsKey: "", startedAt: 0 });
		assert.ok(snapshot);
		assert.equal(compaction.firstKeptEntryId, snapshot.firstKeptEntryId);
		const entriesAtTrigger = rig.observed.entries.at(-1) as Parameters<typeof planSpan>[0];
		const fresh = planSpan(entriesAtTrigger, KEEP_RECENT, estimateTokens);
		assert.ok(fresh);
		assert.notEqual(fresh.firstKeptEntryId, compaction.firstKeptEntryId, "a fresh plan would have cut elsewhere");

		assert.equal(assistantTexts(rig.session).at(-1)?.stopReason, "stop");
	} finally {
		await rig.cleanup();
	}
});

test("e2e: precompute — a job still running at the trigger is awaited, then adopted without a second request", async () => {
	const rig = await createRig({ precompute: true });
	try {
		rig.gate.current = pending();
		// the model answers 300 ms after the request: the agent reaches the trigger first and has to wait
		const timer = setInterval(() => {
			if (rig.summaryRequests.length > 0) {
				clearInterval(timer);
				setTimeout(() => rig.gate.current?.resolve(), 300);
			}
		}, 5);
		const started = Date.now();
		await rig.session.prompt("read the files");
		clearInterval(timer);

		assert.ok(Date.now() - started >= 250, "the agent waited for the in-flight job");
		assert.equal(rig.summaryRequests.length, 1, "no second request at adoption");
		const compaction = compactionEntries(rig.session)[0];
		assert.ok(compaction);
		assert.match(compaction.summary, /FAUX-STATE/);
		assert.equal(assistantTexts(rig.session).at(-1)?.stopReason, "stop");
	} finally {
		await rig.cleanup();
	}
});

test("e2e: precompute — a ctx captured in turn_end stays usable from the job after the handler returned", async () => {
	const rig = await createRig({ precompute: true });
	try {
		const probes: Array<Record<string, unknown>> = [];
		rig.gate.current = pending();
		rig.beforeAgentRequest.current = async () => {
			if (rig.summaryRequests.length === 0 || probes.length > 0) return;
			const ctx = rig.observed.ctx;
			assert.ok(ctx);
			// the same things the job's ctx is used for, long after the turn_end that created it
			probes.push({
				model: ctx.model?.id,
				find: ctx.modelRegistry.find("faux", "faux")?.id,
				branch: ctx.sessionManager.getBranch().length,
				usage: ctx.getContextUsage()?.tokens,
			});
			rig.gate.current?.resolve();
			await sleep(30);
		};
		await rig.session.prompt("read the files");
		assert.equal(probes.length, 1);
		assert.equal(probes[0].model, "faux");
		assert.equal(probes[0].find, "faux");
		assert.ok((probes[0].branch as number) > 0);
		assert.ok((probes[0].usage as number) > 0);
		assert.equal(rig.summaryRequests.length, 1);
	} finally {
		await rig.cleanup();
	}
});

test("e2e: session_recall is registered and returns the text of an output the compaction removed", async () => {
	const rig = await createRig({ precompute: false });
	try {
		assert.ok(rig.session.getAllTools().some((tool) => tool.name === "session_recall"), "session_recall is registered");
		let hit: string | undefined;
		rig.policy.current = (r, context) => {
			// first read the marker file, then filler, until the compaction has happened
			if (compactionEntries(r.session).length === 0) {
				return toolCall("read", { path: r.agentCalls() === 1 ? "a.txt" : "big.txt" });
			}
			const results = (context as { messages: Array<{ role: string; toolName?: string; content: Array<{ type: string; text?: string }> }> }).messages.filter(
				(m) => m.role === "toolResult" && m.toolName === "session_recall",
			);
			if (results.length === 0) return toolCall("session_recall", { query: "MARKER-A" });
			if (results.length === 1) {
				hit = /^\[([0-9a-f]{8})\]/m.exec(results[0].content[0].text ?? "")?.[1];
				return toolCall("session_recall", { entryId: hit ?? "missing" });
			}
			return fauxAssistantMessage("recalled");
		};
		await rig.session.prompt("read the files");

		const results = rig.session.messages.flatMap((m) => (m.role === "toolResult" && m.toolName === "session_recall" ? [m] : []));
		assert.equal(results.length, 2, "a search and a read");
		const text = (i: number) => results[i].content.map((c) => (c.type === "text" ? c.text : "")).join("");
		assert.ok(results.every((r) => !r.isError), text(0));
		assert.match(text(0), /MARKER-A/);
		assert.ok(hit, "the search result carries an entry id");
		assert.match(text(1), /MARKER-A the very first output/); // the removed read output, in full
		assert.match(text(1), /alpha alpha alpha/);
	} finally {
		await rig.cleanup();
	}
});

// ---------------------------------------------------------------------------------------------------
// Lifecycle of the background job

/** Leave a job in flight (the model never answers) and the agent finished. */
async function withJobInFlight(mode: "session" | "runtime") {
	const rig = await createRig({ precompute: true, mode });
	rig.gate.current = pending();
	rig.policy.current = (r) => (r.summaryRequests.length > 0 ? fauxAssistantMessage("stopping early") : toolCall("read", { path: "big.txt" }));
	await rig.session.prompt("read the files");
	assert.equal(rig.summaryRequests.length, 1, "the background job is in flight");
	assert.equal(compactionEntries(rig.session).length, 0);
	return rig;
}

test("e2e: session.dispose() alone does NOT emit session_shutdown and does not abort the job (pi behavior)", async () => {
	const rig = await withJobInFlight("session");
	try {
		const probeCtx = rig.observed.ctx;
		assert.ok(probeCtx);
		assert.equal(probeCtx.model?.id, "faux", "usable before dispose");

		rig.session.dispose();
		await sleep(20);
		assert.deepEqual(rig.observed.shutdowns, [], "no session_shutdown from session.dispose()");
		assert.equal(rig.summaryRequests[0].signal?.aborted, false, "the job's model call keeps running");

		// pi invalidates the captured ctx on dispose: any later use (e.g. a retry of the job) throws
		assert.throws(() => probeCtx.model, /stale/);
		assert.throws(() => probeCtx.sessionManager.getBranch(), /stale/);
		assert.throws(() => probeCtx.modelRegistry.find("faux", "faux"), /stale/);

		// letting the model answer afterwards must not crash anything (no unhandled rejection)
		rig.gate.current?.resolve();
		await sleep(50);
	} finally {
		await rig.cleanup();
	}
});

test("e2e: runtime.dispose() emits session_shutdown and aborts the job's model call", async () => {
	const rig = await withJobInFlight("runtime");
	try {
		assert.equal(rig.summaryRequests[0].signal?.aborted, false);
		await rig.runtime?.dispose();
		assert.deepEqual(rig.observed.shutdowns, ["quit"]);
		assert.equal(rig.summaryRequests[0].signal?.aborted, true, "the job was aborted by session_shutdown");
		await sleep(20);
		assert.equal(rig.summaryRequests.length, 1, "no retry after the abort");
	} finally {
		await rig.cleanup();
	}
});
