import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as agentCore from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context, Model } from "@oh-my-pi/pi-ai";
import { setStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets/obfuscator";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { startCompletionProbe } from "@oh-my-pi/pi-coding-agent/task/completion-probe";
import type { AgentProgress } from "@oh-my-pi/pi-tui/tools/task";

const WORKER_MODEL = buildModel({
	id: "worker-model",
	name: "Worker Model",
	api: "anthropic-messages",
	provider: "worker-provider",
	baseUrl: "https://worker.example.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 4096,
});
const SMOL_MODEL: Model = { ...WORKER_MODEL, id: "smol-model", provider: "smol-provider" };

function assistant(text: string, cost = 0.01): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: SMOL_MODEL.api,
		provider: SMOL_MODEL.provider,
		model: SMOL_MODEL.id,
		usage: {
			input: 10,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 12,
			cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function progress(overrides: Partial<AgentProgress> = {}): AgentProgress {
	return {
		index: 0,
		id: "probe-agent",
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "Inspect bounded completion estimates",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
		...overrides,
	};
}

async function tick(delay = 2 * 60_000): Promise<void> {
	vi.advanceTimersByTime(delay);
	for (let index = 0; index < 12; index++) await Promise.resolve();
}

function userNotes(context: Context): string {
	const message = context.messages[0];
	if (message.role !== "user" || typeof message.content !== "string") throw new Error("Expected progress notes");
	return message.content;
}

async function createHarness(obfuscator?: SecretObfuscator) {
	const authStorage = await AuthStorage.create(":memory:");
	const modelRegistry = new ModelRegistry(authStorage);
	vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([WORKER_MODEL, SMOL_MODEL]);
	vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("fixture-key");
	const settings = Settings.isolated({
		"compaction.enabled": false,
		modelRoles: { smol: `${SMOL_MODEL.provider}/${SMOL_MODEL.id}` },
	});
	const sessionManager = SessionManager.inMemory();
	const agent = new Agent({
		initialState: {
			model: WORKER_MODEL,
			systemPrompt: ["WORKER_SYSTEM_MUST_NOT_LEAVE"],
			tools: [],
			messages: [{ role: "user", content: "PRIVATE_HISTORY_MUST_NOT_LEAVE", timestamp: 1 }],
		},
	});
	const session = new AgentSession({ agent, sessionManager, settings, modelRegistry, obfuscator });
	agent.state.isStreaming = true;
	const controller = new AbortController();
	const estimates: Array<{ percent: number; stage?: string; watch?: string; cost: number }> = [];
	return {
		session,
		modelRegistry,
		settings,
		estimates,
		controller,
		start: (snapshot = progress()) => {
			vi.useFakeTimers();
			startCompletionProbe({
				session: () => session,
				progress: () => snapshot,
				signal: controller.signal,
				onEstimate: (estimate, cost) => estimates.push({ ...estimate, cost }),
			});
		},
		dispose: async () => {
			controller.abort();
			vi.useRealTimers();
			agent.state.isStreaming = false;
			await session.dispose();
			await sessionManager.close();
			authStorage.close();
		},
	};
}

describe("bounded completion probe", () => {
	afterEach(() => vi.restoreAllMocks());

	it("uses the configured smol model without exposing the worker conversation or changing its model", async () => {
		const harness = await createHarness();
		try {
			const call = {
				type: "toolCall" as const,
				id: "streaming-call",
				name: "write",
				arguments: { path: "src/decoder.ts" },
			};
			setStreamingPartialJson(call, '{"path":"src/decoder.ts","content":"unfinished');
			harness.session.agent.state.streamMessage = {
				...assistant(""),
				content: [
					{ type: "thinking", thinking: "PRIVATE_THINKING_MUST_NOT_LEAVE" },
					{ type: "text", text: "RAW_STREAM_MUST_NOT_LEAVE" },
					call,
				],
			};
			const complete = vi
				.spyOn(agentCore, "instrumentedCompleteSimple")
				.mockResolvedValue(
					assistant('{"pct":42,"stage":"implementing decoder","watch":"decoder benchmark throughput"}'),
				);
			harness.start(progress({ currentTool: "write", recentOutput: ["Implemented decoder framing"] }));
			await tick();
			expect(complete).toHaveBeenCalledTimes(1);
			const [model, context, options] = complete.mock.calls[0];
			expect(`${model.provider}/${model.id}`).toBe(`${SMOL_MODEL.provider}/${SMOL_MODEL.id}`);
			expect(harness.session.model).toBe(WORKER_MODEL);
			expect(context.tools).toBeUndefined();
			expect(options.disableReasoning).toBe(true);
			expect(options.maxTokens).toBeLessThanOrEqual(256);
			const payload = JSON.stringify(context);
			for (const forbidden of [
				"PRIVATE_HISTORY_MUST_NOT_LEAVE",
				"WORKER_SYSTEM_MUST_NOT_LEAVE",
				"PRIVATE_THINKING_MUST_NOT_LEAVE",
				"RAW_STREAM_MUST_NOT_LEAVE",
			]) {
				expect(payload).not.toContain(forbidden);
			}
			expect(userNotes(context)).toContain("src/decoder.ts");
			expect(userNotes(context)).toContain("Implemented decoder framing");
			expect(harness.estimates).toEqual([
				{ percent: 42, stage: "implementing decoder", watch: "decoder benchmark throughput", cost: 0.01 },
			]);
		} finally {
			await harness.dispose();
		}
	});

	it("bounds oversized activity and retains both ends of the assignment", async () => {
		const harness = await createHarness();
		try {
			const complete = vi.spyOn(agentCore, "instrumentedCompleteSimple").mockResolvedValue(assistant('{"pct":15}'));
			harness.start(
				progress({
					assignment: `ASSIGNMENT_HEAD${"m".repeat(4000)}OMITTED_MIDDLE${"m".repeat(4000)}ASSIGNMENT_TAIL`,
					recentTools: Array.from({ length: 30 }, (_, index) => ({
						tool: `tool-${index}`,
						args: "a".repeat(400),
						intent: "i".repeat(400),
						endMs: index,
					})),
					recentOutput: Array.from({ length: 30 }, (_, index) => `output-${index}-${"o".repeat(400)}`),
				}),
			);
			await tick();
			expect(complete).toHaveBeenCalledTimes(1);
			const body = userNotes(complete.mock.calls[0][1]);
			expect(body.length).toBeLessThanOrEqual(6000);
			expect(body).toContain("ASSIGNMENT_HEAD");
			expect(body).toContain("ASSIGNMENT_TAIL");
			expect(body).not.toContain("OMITTED_MIDDLE");
			expect(body).not.toContain("tool-29");
			expect(body).not.toContain("output-29");
		} finally {
			await harness.dispose();
		}
	});

	it("skips unavailable models and credentials rather than switching to the worker", async () => {
		const harness = await createHarness();
		try {
			vi.spyOn(harness.modelRegistry, "getAvailable").mockReturnValue([WORKER_MODEL]);
			const complete = vi.spyOn(agentCore, "instrumentedCompleteSimple");
			harness.start();
			await tick();
			expect(complete).not.toHaveBeenCalled();
			vi.spyOn(harness.modelRegistry, "getAvailable").mockReturnValue([WORKER_MODEL, SMOL_MODEL]);
			vi.spyOn(harness.modelRegistry, "getApiKey").mockResolvedValue(undefined);
			await tick(5 * 60_000);
			expect(complete).not.toHaveBeenCalled();
			expect(harness.estimates).toEqual([]);
			expect(harness.session.model).toBe(WORKER_MODEL);
		} finally {
			await harness.dispose();
		}
	});

	it("obfuscates configured secrets before sending notes and restores placeholders in the displayed estimate", async () => {
		const secret = "PROBE_SECRET_FIXTURE_12345";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }]);
		const placeholder = obfuscator.obfuscate(secret);
		const harness = await createHarness(obfuscator);
		try {
			const complete = vi
				.spyOn(agentCore, "instrumentedCompleteSimple")
				.mockResolvedValue(assistant(JSON.stringify({ pct: 55, watch: placeholder })));
			harness.start(progress({ recentOutput: [`Output includes ${secret}`] }));
			await tick();
			expect(complete).toHaveBeenCalledTimes(1);
			expect(userNotes(complete.mock.calls[0][1])).not.toContain(secret);
			expect(harness.estimates).toEqual([{ percent: 55, watch: secret, cost: 0.01 }]);
		} finally {
			await harness.dispose();
		}
	});

	it("records malformed and late cancelled responses without publishing stale estimates", async () => {
		const harness = await createHarness();
		try {
			const complete = vi
				.spyOn(agentCore, "instrumentedCompleteSimple")
				.mockResolvedValueOnce(assistant("not an estimate", 0.015));
			harness.start();
			await tick();
			expect(harness.estimates).toEqual([]);
			expect(harness.session.sessionManager.getUsageStatistics().cost).toBeCloseTo(0.015, 9);
			const pending = Promise.withResolvers<AssistantMessage>();
			complete.mockReturnValueOnce(pending.promise);
			await tick(5 * 60_000);
			expect(complete).toHaveBeenCalledTimes(2);
			harness.controller.abort();
			pending.resolve(assistant('{"pct":80}', 0.03));
			for (let index = 0; index < 12; index++) await Promise.resolve();
			expect(harness.estimates).toEqual([]);
			expect(harness.session.sessionManager.getUsageStatistics().cost).toBeCloseTo(0.045, 9);
			expect(harness.session.sessionManager.getEntries().filter(entry => entry.type === "model_usage")).toHaveLength(
				2,
			);
		} finally {
			await harness.dispose();
		}
	});
});
