import type { ObservedProviderModelV1 } from "@/lib/agents/providerModels";

/** Explicit provider responses for picker tests; never imported by product code. */
export const codexModelCatalog: readonly ObservedProviderModelV1[] = [
	{
		value: "gpt-5.6-sol",
		displayName: "GPT-5.6 Sol",
		supportsEffort: true,
		supportedEffortLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
	},
	{
		value: "gpt-5.6-luna",
		displayName: "GPT-5.6 Luna",
		supportsEffort: true,
		supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
	},
];

export const claudeModelCatalog: readonly ObservedProviderModelV1[] = [
	{
		value: "fable",
		displayName: "Fable",
		supportsEffort: true,
		supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
	},
];
