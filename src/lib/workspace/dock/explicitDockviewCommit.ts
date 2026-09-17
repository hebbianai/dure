import type { DockviewApi } from "dockview-react";
import { dockviewRegistry } from "@/lib/workspace/dock/dockRegistry";
import { publishLayoutPush } from "@/lib/workspace/layout/layoutPushChannel";
import { useStore } from "@/store";

interface ExplicitDockviewCommitOptions<Result> {
	desktopId: string;
	api: DockviewApi;
	mutate: () => Result;
	targetChangedError: () => Error;
}

function assertMutationTarget(
	desktopId: string,
	api: DockviewApi,
	targetChangedError: () => Error,
): void {
	if (dockviewRegistry.get(desktopId) !== api) {
		throw targetChangedError();
	}
}

/** Commit one correlated app-server mutation without relying on the focused
 * Workspace writer. The caller still owns compensation outside Dockview. */
export function commitExplicitDockviewMutation<Result>({
	desktopId,
	api,
	mutate,
	targetChangedError,
}: ExplicitDockviewCommitOptions<Result>): Result {
	assertMutationTarget(desktopId, api, targetChangedError);
	const before = api.toJSON();
	try {
		const result = mutate();
		assertMutationTarget(desktopId, api, targetChangedError);
		useStore.getState().saveLayout(desktopId, api.toJSON());
		publishLayoutPush([desktopId]);
		return result;
	} catch (error) {
		try {
			api.fromJSON(before, { reuseExistingPanels: true });
		} catch {
			// Preserve the correlated request's original mutation/commit error.
		}
		throw error;
	}
}
