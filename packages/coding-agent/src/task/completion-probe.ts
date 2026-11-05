import { instrumentedCompleteSimple, resolveTelemetry } from "@oh-my-pi/pi-agent-core";
import { withCredentialRedaction } from "@oh-my-pi/pi-ai/providers/transform-messages";
import { getStreamingPartialJson, markPerCallContextMessage } from "@oh-my-pi/pi-ai/utils/block-symbols";
import {
	formatDuration,
	isInteractiveHost,
	isRecord,
	jsonContainerEnd,
	logger,
	truncate,
	sanitizeText,
} from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import type { AgentProgress } from "@oh-my-pi/pi-tui/tools/task";
import { resolveModelOverride, rolePriorityDefaults } from "../config/model-resolver";
import completionProbePrompt from "../prompts/system/subagent-completion-probe.md" with { type: "text" };
import type { AgentSession } from "../session/agent-session";
import { cfgSecretsEnabled } from "../secrets/settings";
import { truncateTinyMessage } from "../tiny/message-preproc";
import { cfgTaskCompletionProbe } from "./settings";

/**
 * Wait before each successive probe: early estimates come quickly, long runs back
 * off to one side request an hour. The last entry repeats.
 */
const PROBE_DELAYS_MS = [2, 5, 10, 30, 60].map(minutes => minutes * 60_000);
const MAX_BRIEF_CHARS = 6000;
const MAX_PROBE_TOKENS = 256;

/**
 * Whether a subagent spawned by a session at `parentDepth` gets completion probes.
 * Only the interactive TUI shows the estimate, so print/RPC/ACP/SDK hosts never pay
 * for it, and only the main agent's direct subagents (`parentDepth` 0) are probed.
 * Callers: the task executor and eval workpool, when building a run monitor.
 */
export function isCompletionProbeEnabled(settings: Settings, parentDepth: number): boolean {
	return parentDepth === 0 && isInteractiveHost() && cfgTaskCompletionProbe.get(settings);
}

/** Inputs for {@link startCompletionProbe}. */
export interface CompletionProbeOptions {
	/** The run's current session; probing skips ticks while it is absent or idle. */
	session: () => AgentSession | null;
	progress: () => AgentProgress;
	/** Stops the timer and cancels an in-flight probe. */
	signal: AbortSignal;
	/** Receives each parsed estimate with the side request's cost in USD. */
	onEstimate: (estimate: CompletionEstimate, cost: number) => void;
}

/** One parsed probe reply. */
export interface CompletionEstimate {
	/** Whole-number completion, 0–100. */
	percent: number;
	/** The agent's current step in its own words; ≤ {@link MAX_STAGE_CHARS} chars, one line. */
	stage?: string;
	/** Which output or metric shows the agent's progress and what target; ≤ {@link MAX_WATCH_CHARS} chars, one line. */
	watch?: string;
}

/** Longest stage line kept from a probe reply. */
export const MAX_STAGE_CHARS = 80;
/** Longest watch hint kept from a probe reply. */
export const MAX_WATCH_CHARS = 200;

function clampPercent(value: number): number {
	return Math.min(100, Math.max(0, Math.round(value)));
}

/**
 * Extract a 0–100 percentage from a probe reply (`"40%"`, `"~65 %"`, `"Roughly 70%."`).
 * Returns `undefined` when the reply carries no percentage.
 */
export function parseCompletionPercent(reply: string): number | undefined {
	const match = /(\d{1,3}(?:\.\d+)?)\s*%/.exec(reply);
	if (!match) return undefined;
	const value = Number(match[1]);
	if (!Number.isFinite(value)) return undefined;
	return clampPercent(value);
}

/** A free-text reply field as one sanitized line of at most `max` chars; `undefined` when empty or not a string. */
function replyLine(value: unknown, max: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const line = sanitizeText(value).replace(/\s+/g, " ").trim();
	if (line.length === 0) return undefined;
	return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** `pct` as a number (`40`, `40.5`) or a numeric string (`"40"`, `"40%"`). */
function replyPercent(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? clampPercent(value) : undefined;
	if (typeof value !== "string") return undefined;
	const match = /^\s*(\d{1,3}(?:\.\d+)?)\s*%?\s*$/.exec(value);
	return match ? clampPercent(Number(match[1])) : undefined;
}

/**
 * Balanced `{…}` spans of `text`, outermost first in reading order. String
 * literals are skipped so braces inside a stage line do not split the object.
 */
function jsonObjectSpans(text: string): string[] {
	const spans: string[] = [];
	for (let start = text.indexOf("{"); start !== -1;) {
		const end = jsonContainerEnd(text, start);
		if (end === -1) break;
		spans.push(text.slice(start, end));
		start = text.indexOf("{", end);
	}
	return spans;
}

/**
 * Parse a probe reply: the JSON line `{"pct": 40, "stage": "…", "watch": "…"}`,
 * also when wrapped in a code fence or surrounded by prose. `pct` is clamped to
 * 0–100; `stage` and `watch` are flattened to one line and capped at
 * {@link MAX_STAGE_CHARS} / {@link MAX_WATCH_CHARS}. A reply without a usable
 * JSON `pct` falls back to a plain percentage (`40%`, see
 * {@link parseCompletionPercent}), keeping any stage/watch the JSON carried.
 * Returns `undefined` when no percentage can be read.
 */
export function parseCompletionEstimate(reply: string): CompletionEstimate | undefined {
	let stage: string | undefined;
	let watch: string | undefined;
	for (const span of jsonObjectSpans(reply)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(span);
		} catch {
			continue;
		}
		if (!isRecord(parsed)) continue;
		stage ??= replyLine(parsed.stage, MAX_STAGE_CHARS);
		watch ??= replyLine(parsed.watch, MAX_WATCH_CHARS);
		const percent = replyPercent(parsed.pct ?? parsed.percent);
		if (percent !== undefined) {
			return {
				percent,
				...(stage !== undefined ? { stage } : {}),
				...(watch !== undefined ? { watch } : {}),
			};
		}
	}
	const percent = parseCompletionPercent(reply);
	if (percent === undefined) return undefined;
	return { percent, ...(stage !== undefined ? { stage } : {}), ...(watch !== undefined ? { watch } : {}) };
}

interface InflightToolCall {
	name: string;
	path?: string;
	chars?: number;
}

function inflightToolCalls(session: AgentSession): InflightToolCall[] {
	const message = session.agent.state.streamMessage;
	if (message?.role !== "assistant") return [];
	const calls: InflightToolCall[] = [];
	for (const block of message.content) {
		if (block.type !== "toolCall") continue;
		const path = block.arguments?.path;
		calls.push({
			name: truncate(block.name, 80),
			path: typeof path === "string" ? truncate(path, 256) : undefined,
			chars: getStreamingPartialJson(block)?.length,
		});
		if (calls.length === 8) break;
	}
	return calls;
}

/**
 * Probe the run's session on the {@link PROBE_DELAYS_MS} schedule until `signal`
 * aborts. Each delay counts from the end of the previous probe, so probes never
 * overlap. A tick that finds the session idle is skipped; failures are logged.
 * Both still advance the schedule.
 */
export function startCompletionProbe(options: CompletionProbeOptions): void {
	const { signal } = options;
	if (signal.aborted) return;
	let step = 0;
	let timer: NodeJS.Timeout | undefined;
	let previous: (CompletionEstimate & { at: number }) | undefined;
	const probe = async (): Promise<void> => {
		const session = options.session();
		if (!session?.isStreaming || signal.aborted) return;
		try {
			const usageOwner = {
				sessionId: session.sessionManager.getSessionId(),
				parentId: session.sessionManager.getLeafId(),
			};
			const progress = options.progress();
			const brief = truncate(
				JSON.stringify({
					assignment: truncateTinyMessage(progress.assignment ?? progress.task),
					previous: previous && {
						percent: previous.percent,
						stage: previous.stage,
						watch: previous.watch,
						ago: formatDuration(Date.now() - previous.at),
					},
					currentTool: progress.currentTool && truncate(progress.currentTool, 80),
					currentToolArgs: progress.currentToolArgs && truncate(progress.currentToolArgs, 300),
					intent: progress.lastIntent && truncate(progress.lastIntent, 300),
					currentToolIntent: progress.currentToolIntent && truncate(progress.currentToolIntent, 300),
					inflight: inflightToolCalls(session),
					recentTools: progress.recentTools.slice(0, 4).map(tool => ({
						tool: truncate(tool.tool, 80),
						intent: tool.intent && truncate(tool.intent, 200),
						args: truncate(tool.args, 200),
						isError: tool.isError,
					})),
					recentOutput: progress.recentOutput.slice(0, 8).map(line => truncate(line, 300)),
				}),
				MAX_BRIEF_CHARS,
			);
			const { settings, modelRegistry } = session;
			const configured = settings.getModelRole("smol");
			const { model } = resolveModelOverride(
				configured ? [configured] : rolePriorityDefaults("smol"),
				modelRegistry,
				settings,
			);
			if (!model || !(await modelRegistry.getApiKey(model, usageOwner.sessionId, { signal }))) return;
			signal.throwIfAborted();
			const costGate = session.costGate;
			costGate.admit();
			const redacted = session.obfuscator?.obfuscate(brief) ?? brief;
			const context = {
				systemPrompt: [completionProbePrompt],
				messages: [{ role: "user" as const, content: truncate(redacted, MAX_BRIEF_CHARS), timestamp: Date.now() }],
			};
			markPerCallContextMessage(context.messages[0]);
			const assistantMessage = await withCredentialRedaction(cfgSecretsEnabled.get(settings), () =>
				instrumentedCompleteSimple(
					model,
					context,
					{
						apiKey: modelRegistry.resolver(model, usageOwner.sessionId),
						sessionId: `${usageOwner.sessionId}:completion-probe`,
						signal,
						disableReasoning: true,
						maxTokens: MAX_PROBE_TOKENS,
					},
					{
						telemetry: resolveTelemetry(session.agent.telemetry, usageOwner.sessionId),
						oneshotKind: "task_completion_probe",
					},
				),
			);
			costGate.record(assistantMessage.usage?.cost?.total ?? 0);
			if (assistantMessage.usage) {
				session.sessionManager.appendModelUsage(
					{
						purpose: "task-completion-probe",
						role: "smol",
						api: assistantMessage.api,
						provider: assistantMessage.provider,
						model: assistantMessage.model,
						usage: assistantMessage.usage,
						stopReason: assistantMessage.stopReason,
					},
					usageOwner,
				);
			}
			if (assistantMessage.stopReason === "error" || assistantMessage.stopReason === "aborted") return;
			const rawReply = assistantMessage.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join("\n");
			const replyText = session.obfuscator?.deobfuscate(rawReply) ?? rawReply;
			const estimate = parseCompletionEstimate(replyText);
			if (signal.aborted) return;
			if (estimate === undefined) {
				logger.debug("Subagent completion probe reply had no percentage", { reply: replyText.slice(0, 200) });
				return;
			}
			previous = { ...estimate, at: Date.now() };
			options.onEstimate(estimate, assistantMessage.usage?.cost?.total ?? 0);
		} catch (error) {
			if (!signal.aborted) {
				logger.debug("Subagent completion probe failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	};
	const schedule = (): void => {
		const delay = PROBE_DELAYS_MS[Math.min(step++, PROBE_DELAYS_MS.length - 1)];
		timer = setTimeout(async () => {
			await probe();
			if (!signal.aborted) schedule();
		}, delay);
		timer.unref?.();
	};
	schedule();
	signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
}
