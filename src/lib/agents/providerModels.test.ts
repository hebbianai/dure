import { describe, expect, it } from "vitest";
import {
	catalogEffortOptions,
	catalogModelOptions,
	humanizeModelId,
	parseProviderModels,
} from "@/lib/agents/providerModels";

describe("humanizeModelId", () => {
	it("humanizes Claude ids without maintaining a model label registry", () => {
		expect(humanizeModelId("gpt-5.6-sol")).toBe("gpt-5.6-sol");
		expect(humanizeModelId("fable")).toBe("fable");
		expect(humanizeModelId("claude-opus-5")).toBe("Opus 5");
		expect(humanizeModelId("claude-fable-5")).toBe("Fable 5");
		expect(humanizeModelId("claude-sonnet-4-5-20250929")).toBe("Sonnet 4.5");
		expect(humanizeModelId("some-unknown-model")).toBe("some-unknown-model");
	});
});

describe("observed catalog options", () => {
	const models = [
		{
			value: "fable",
			resolvedModel: "claude-fable-5",
			displayName: "Fable",
			supportsEffort: true,
			supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
		},
		{
			value: "haiku",
			displayName: "Haiku",
			supportsEffort: false,
			supportedEffortLevels: [],
		},
	] as const;

	it("derives model options from what the runtime reported", () => {
		expect(catalogModelOptions(models)).toEqual([
			{ value: "fable", label: "Fable" },
			{ value: "haiku", label: "Haiku" },
		]);
	});

	it("matches efforts by alias or resolved id and appends ultracode", () => {
		const byAlias = catalogEffortOptions("claude", models, "fable");
		expect(byAlias.map((option) => option.value)).toEqual([
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
			"ultracode",
		]);
		expect(
			catalogEffortOptions("claude", models, "claude-fable-5").map(
				(option) => option.value,
			),
		).toEqual(byAlias.map((option) => option.value));
		expect(catalogEffortOptions("claude", models, "haiku")).toEqual([]);
	});

	it("offers only efforts every model supports when Auto has no observed model", () => {
		expect(
			catalogEffortOptions("codex", models, null).map((option) => option.value),
		).toEqual([]);
	});
});

describe("parseProviderModels", () => {
	it("accepts future model and effort names and context-window qualifiers", () => {
		const models = parseProviderModels([
			{
				value: "provider-next[1m]",
				displayName: "Next",
				supportsEffort: true,
				supportedEffortLevels: ["deeper"],
			},
		]);
		expect(catalogModelOptions(models ?? [])).toEqual([
			{ value: "provider-next[1m]", label: "Next" },
		]);
		expect(
			catalogEffortOptions("codex", models ?? [], "provider-next[1m]"),
		).toEqual([{ value: "deeper", label: "Deeper" }]);
		expect(parseProviderModels([])).toEqual([]);
		expect(parseProviderModels(null)).toBeNull();
	});
});
