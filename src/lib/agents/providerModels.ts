import type { Provider } from "@/types";

export function parseProviderModels(
	models: unknown,
): readonly ObservedProviderModelV1[] | null {
	if (!Array.isArray(models)) return null;
	return models.flatMap((entry): ObservedProviderModelV1[] => {
		if (!entry || typeof entry !== "object") return [];
		const model = entry as Record<string, unknown>;
		if (typeof model.value !== "string" || model.value.length === 0) {
			return [];
		}
		return [
			{
				value: model.value,
				...(typeof model.resolvedModel === "string"
					? { resolvedModel: model.resolvedModel }
					: {}),
				displayName:
					typeof model.displayName === "string" && model.displayName
						? model.displayName
						: model.value,
				supportsEffort: model.supportsEffort === true,
				supportedEffortLevels: Array.isArray(model.supportedEffortLevels)
					? model.supportedEffortLevels.filter(
							(level): level is string => typeof level === "string",
						)
					: [],
			},
		];
	});
}

/** One selectable model for a provider's launch `--model` flag. `value` is
 * the exact string the provider CLI accepts (opaque to the core contract);
 * `label` is the display name (product names, not translatable copy). */
export interface ProviderModelOption {
	readonly value: string;
	readonly label: string;
}

/** One selectable reasoning effort for a provider's launch config. Same
 * opaque-value contract as models: the CLI owns the meaning. */
export interface ProviderEffortOption {
	readonly value: string;
	readonly label: string;
}

/** Display an unknown model without maintaining a second model registry. */
export function humanizeModelId(value: string): string {
	if (!value.startsWith("claude-")) return value;
	const segments = value
		.slice("claude-".length)
		.split("-")
		.filter((segment) => !/^\d{8}$/.test(segment));
	const words: string[] = [];
	let numeric: string[] = [];
	for (const segment of segments) {
		if (/^\d+$/.test(segment)) {
			numeric.push(segment);
			continue;
		}
		if (numeric.length > 0) {
			words.push(numeric.join("."));
			numeric = [];
		}
		words.push(segment.charAt(0).toUpperCase() + segment.slice(1));
	}
	if (numeric.length > 0) words.push(numeric.join("."));
	return words.length > 0 ? words.join(" ") : value;
}

/** Provider-reported model choices. UI code never supplies a fallback catalog. */
export interface ObservedProviderModelV1 {
	readonly value: string;
	readonly resolvedModel?: string;
	readonly displayName: string;
	readonly supportsEffort: boolean;
	readonly supportedEffortLevels: readonly string[];
}

const EFFORT_LABELS: Readonly<Record<string, string>> = {
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "XHigh",
	max: "Max",
	ultra: "Ultra",
};

function effortLabel(value: string): string {
	return EFFORT_LABELS[value] ?? value.charAt(0).toUpperCase() + value.slice(1);
}

export function catalogModelOptions(
	models: readonly ObservedProviderModelV1[],
): readonly ProviderModelOption[] {
	return models.map((model) => ({
		value: model.value,
		label: model.displayName,
	}));
}

/** Session-mode entries that ride a provider's settings channel rather than
 * its effort flag, so the runtime catalog never lists them. Each is offered
 * whenever the reported ladder includes its gate rung. */
const SESSION_EFFORT_EXTENSIONS: Partial<
	Record<
		Provider,
		readonly { readonly gate: string; readonly option: ProviderEffortOption }[]
	>
> = {
	claude: [
		{ gate: "xhigh", option: { value: "ultracode", label: "Ultracode" } },
	],
};

/** Effort choices from the observed catalog for the selected (or reported)
 * model — matching either the alias value or the canonical id it resolves
 * to. With Auto and no observed model, only efforts common to every entry are
 * selectable. An unknown explicit model supplies no effort claims. */
export function catalogEffortOptions(
	provider: Provider,
	models: readonly ObservedProviderModelV1[],
	model: string | null,
): readonly ProviderEffortOption[] {
	const entry =
		model === null
			? undefined
			: models.find(
					(candidate) =>
						candidate.value === model || candidate.resolvedModel === model,
				);
	const levels =
		entry !== undefined
			? entry.supportsEffort
				? entry.supportedEffortLevels
				: []
			: model === null
				? (models[0]?.supportedEffortLevels ?? []).filter((level) =>
						models.every(
							(candidate) =>
								candidate.supportsEffort &&
								candidate.supportedEffortLevels.includes(level),
						),
					)
				: [];
	const options = levels.map((value) => ({ value, label: effortLabel(value) }));
	for (const extension of SESSION_EFFORT_EXTENSIONS[provider] ?? []) {
		if (levels.includes(extension.gate)) options.push(extension.option);
	}
	return options;
}
