import { describe, expect, it } from "bun:test";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import { computeNonMessageBreakdown, estimateToolSchemaTokens } from "@oh-my-pi/pi-tui/status-line/context-usage";
import { applyToolProxy } from "../../src/extensibility/tool-proxy";

const tokenizer = new Tokenizer();

/** External arktype copies expose bind on callable schemas, unlike omptype. */
function bindCapableSchema() {
	return Object.assign((value: unknown) => value, {
		toJsonSchema: () => ({ type: "object", properties: { a: { type: "string" } } }),
		assert: (value: unknown) => value,
	});
}

describe("extension tool context accounting", () => {
	it("counts a proxied bind-capable callable schema by its wire JSON Schema", () => {
		// Binding the schema loses its wire surface and once poisoned token accounting.
		const schema = bindCapableSchema();
		const unwrapped = { name: "ext", description: "ext tool", parameters: schema };
		const wrapper: Record<string, unknown> = {};
		applyToolProxy(unwrapped, wrapper);
		const proxied = wrapper as { name: string; description: string; parameters: unknown };
		expect(estimateToolSchemaTokens([proxied as never], tokenizer)).toBe(
			estimateToolSchemaTokens([unwrapped as never], tokenizer),
		);
		expect(estimateToolSchemaTokens([proxied as never], tokenizer)).toBeGreaterThan(0);
	});

	it("runs the full non-message breakdown on a proxied extension tool", () => {
		const schema = bindCapableSchema();
		const wrapper: Record<string, unknown> = {};
		applyToolProxy({ name: "ext", description: "ext tool", parameters: schema }, wrapper);
		const session = { systemPrompt: ["base"], agent: { state: { tools: [wrapper] } } };
		const breakdown = computeNonMessageBreakdown(session as never, tokenizer);
		expect(breakdown.toolsTokens).toBeGreaterThan(0);
	});
});

/**
 * Contract: `skills.catalogDescriptionBudgetChars` empties descriptions past its
 * cap in the rendered prompt, so accounting must drop them too. Counting the
 * unbudgeted catalogue inflates the Skills category and over-subtracts from
 * System prompt, which can push the category totals past `usedTokens`.
 */
describe("computeNonMessageBreakdown skills description budget", () => {
	const readTool = { name: "read", description: "read files", parameters: {} };
	const wordy = { name: "wordy", description: "W".repeat(4000), filePath: "/s/w.md" };
	const terse = { name: "terse", description: "small", filePath: "/s/t.md" };
	const nameOnlyPrompt = "You are an agent.\nSkills:\n- wordy\n- terse\n";

	function session(budgetChars?: number) {
		return {
			systemPrompt: [nameOnlyPrompt],
			agent: { state: { tools: [readTool] } },
			skills: [wordy, terse],
			skillsSettings: budgetChars === undefined ? undefined : { catalogDescriptionBudgetChars: budgetChars },
		} as never;
	}

	it("excludes descriptions the budget omitted", () => {
		const budgeted = computeNonMessageBreakdown(session(0), tokenizer);
		const unbudgeted = computeNonMessageBreakdown(session(-1), tokenizer);
		expect(budgeted.skillsTokens).toBeLessThan(unbudgeted.skillsTokens);
		expect(budgeted.skillsTokens).toBeGreaterThan(0);
		expect(budgeted.skillsTokens).toBeLessThan(100);
	});

	it("does not over-subtract from the System prompt category", () => {
		expect(computeNonMessageBreakdown(session(0), tokenizer).systemPromptTokens).toBeGreaterThan(0);
	});

	it("counts every description when no budget is configured", () => {
		expect(computeNonMessageBreakdown(session(), tokenizer).skillsTokens).toBe(
			computeNonMessageBreakdown(session(-1), tokenizer).skillsTokens,
		);
	});

	it("re-splits when the budget changes on a stable skills reference (memo keyed on budget)", () => {
		// One object mutated in place: the skills/tools/prompt refs are unchanged,
		// so only a budget-aware memo key forces the recompute. Without it the
		// stale unlimited split would be served.
		const src = {
			systemPrompt: [nameOnlyPrompt],
			agent: { state: { tools: [readTool] } },
			skills: [wordy, terse],
			skillsSettings: { catalogDescriptionBudgetChars: -1 },
		};
		const unlimited = computeNonMessageBreakdown(src as never, tokenizer).skillsTokens;
		src.skillsSettings.catalogDescriptionBudgetChars = 0;
		expect(computeNonMessageBreakdown(src as never, tokenizer).skillsTokens).toBeLessThan(unlimited);
	});
});

/**
 * Contract: `TaskTool.description` is a live getter over
 * `task.agentCatalogDescriptionBudgetChars`, so changing that setting rewrites a
 * tool description in place while the tools array keeps its identity. The memo
 * keys off that identity, so the budget has to join the key or the stale tool
 * total survives and compaction is sized against a catalogue that no longer
 * matches the provider-bound one.
 */
describe("computeNonMessageBreakdown agent catalogue budget", () => {
	function sourceWithLiveTaskDescription(budgetChars: number) {
		const settings = { catalogDescriptionBudgetChars: budgetChars, revision: 0 };
		// Stands in for TaskTool: one stable object whose description re-renders
		// from the current budget on every read.
		const taskTool = {
			name: "task",
			parameters: {},
			get description() {
				return settings.catalogDescriptionBudgetChars === 0
					? "Available agents: scout, designer, reviewer"
					: `Available agents:\n${"scout does deep investigation across the repository. ".repeat(40)}`;
			},
		};
		return {
			source: { systemPrompt: ["You are an agent."], agent: { state: { tools: [taskTool] } }, skills: [] },
			settingsStore: settings,
		};
	}

	it("recomputes tool tokens when the budget changes on a stable tools reference", () => {
		const { source, settingsStore } = sourceWithLiveTaskDescription(-1);
		const unlimited = computeNonMessageBreakdown(source as never, tokenizer, settingsStore.revision).toolsTokens;
		settingsStore.catalogDescriptionBudgetChars = 0;
		settingsStore.revision++;
		expect(computeNonMessageBreakdown(source as never, tokenizer, settingsStore.revision).toolsTokens).toBeLessThan(unlimited);
	});

	it("recomputes the collapsed non-message total for the same change", () => {
		const { source, settingsStore } = sourceWithLiveTaskDescription(0);
		const nameOnly = computeNonMessageTokens(source as never, tokenizer, settingsStore.revision);
		settingsStore.catalogDescriptionBudgetChars = -1;
		settingsStore.revision++;
		// Raising the budget must not serve the cached name-only total, which
		// would undercount and skip compaction that is actually needed.
		expect(computeNonMessageTokens(source as never, tokenizer, settingsStore.revision)).toBeGreaterThan(nameOnly);
	});
});
