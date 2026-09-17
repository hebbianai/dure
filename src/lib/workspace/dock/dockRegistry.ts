import type { DockviewApi } from "dockview-react";
import { publishDockviewRegistration } from "@/lib/workspace/dock/dockviewRegistration";
import { installDockviewSinglePaneActivation } from "@/lib/workspace/dock/dockviewSinglePaneActivation";
import { useStore } from "@/store";

export const dockviewRegistry = new Map<string, DockviewApi>();
const activationDisposers = new WeakMap<DockviewApi, () => void>();
const projectionOnlyMutationDepth = new WeakMap<DockviewApi, number>();

/** Project an already-durable layout change without handing it back to the
 * ordinary Dockview writer as a second persistent mutation. */
export function runDockviewProjectionOnly<Result>(
	api: DockviewApi,
	mutation: () => Result,
): Result {
	const depth = projectionOnlyMutationDepth.get(api) ?? 0;
	projectionOnlyMutationDepth.set(api, depth + 1);
	try {
		return mutation();
	} finally {
		// Dockview publishes the structural layout event in a microtask after the
		// mutation returns. Keep the projection marker through that event without
		// introducing a timer or a second durable coordination path.
		queueMicrotask(() => {
			const currentDepth = projectionOnlyMutationDepth.get(api) ?? 0;
			if (currentDepth <= 1) projectionOnlyMutationDepth.delete(api);
			else projectionOnlyMutationDepth.set(api, currentDepth - 1);
		});
	}
}

export function isDockviewProjectionOnly(api: DockviewApi): boolean {
	return projectionOnlyMutationDepth.has(api);
}

export function registerDockview(desktopId: string, api: DockviewApi): void {
	activationDisposers.get(api)?.();
	activationDisposers.set(api, installDockviewSinglePaneActivation(api));
	dockviewRegistry.set(desktopId, api);
	publishDockviewRegistration(desktopId);
}

export function unregisterDockview(desktopId: string, api: DockviewApi): void {
	if (dockviewRegistry.get(desktopId) === api) {
		dockviewRegistry.delete(desktopId);
		activationDisposers.get(api)?.();
		activationDisposers.delete(api);
	}
}

export function getDockview(desktopId: string): DockviewApi | undefined {
	return dockviewRegistry.get(desktopId);
}

export function mountedDockviewEntries(): readonly [string, DockviewApi][] {
	return [...dockviewRegistry.entries()];
}

export function registeredDesktopIdFor(api: DockviewApi): string | undefined {
	for (const [desktopId, registered] of dockviewRegistry) {
		if (registered === api) return desktopId;
	}
	return undefined;
}

/** Wait for a desktop's dockview to mount; undefined once the desktop itself
 * is gone or the deadline passes without a registration. */
export async function waitForDesktopDockview(
	desktopId: string,
	timeoutMs = 5_000,
): Promise<DockviewApi | undefined> {
	const deadline = Date.now() + timeoutMs;
	do {
		const api = dockviewRegistry.get(desktopId);
		if (api) return api;
		if (
			!useStore.getState().spaces.some((desktop) => desktop.id === desktopId)
		) {
			return undefined;
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
	} while (Date.now() < deadline);
	return dockviewRegistry.get(desktopId);
}

/** Session cleanup guard while a pane changes layout ownership. */
export const movingPanels = new Set<string>();
