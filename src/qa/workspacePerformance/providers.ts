import { PROVIDERS, type Provider } from "@/types";
import providerDefinitions from "./providers.json";

export type WorkspacePerformanceResizeBuffer = "alternate" | "normal";

export interface WorkspacePerformanceProviderDescriptor {
	id: Provider;
	title: string;
	resizeBuffer: WorkspacePerformanceResizeBuffer;
}

export type WorkspacePerformanceProvider = Provider;

function providerDescriptor(
	candidate: (typeof providerDefinitions.providers)[number],
): WorkspacePerformanceProviderDescriptor {
	if (
		providerDefinitions.schemaVersion !== 1 ||
		!Object.keys(PROVIDERS).includes(candidate.id) ||
		!(["alternate", "normal"] as const).includes(
			candidate.resizeBuffer as WorkspacePerformanceResizeBuffer,
		)
	) {
		throw new Error("invalid workspace performance provider descriptor");
	}
	const id = candidate.id as Provider;
	return Object.freeze({
		id,
		title: PROVIDERS[id].label,
		resizeBuffer: candidate.resizeBuffer as WorkspacePerformanceResizeBuffer,
	});
}

export const WORKSPACE_PERFORMANCE_PROVIDERS = Object.freeze(
	providerDefinitions.providers.map(providerDescriptor),
);

if (WORKSPACE_PERFORMANCE_PROVIDERS.length === 0) {
	throw new Error("workspace performance provider set is empty");
}

export function workspacePerformanceProviderDescriptor(provider: Provider) {
	return WORKSPACE_PERFORMANCE_PROVIDERS.find(
		(descriptor) => descriptor.id === provider,
	);
}

export function workspacePerformanceProviderForCell(
	desktop: number,
	pane: number,
) {
	const descriptor =
		WORKSPACE_PERFORMANCE_PROVIDERS[
			(desktop + pane) % WORKSPACE_PERFORMANCE_PROVIDERS.length
		];
	if (!descriptor)
		throw new Error("workspace performance provider set is empty");
	return descriptor;
}
