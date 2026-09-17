import { useCallback, useSyncExternalStore } from "react";
import type { DockviewPanelApi } from "dockview-react";

/** Whether this pane currently lives in a floating (overlay) group.
 * Mirrors useDockviewGroupActive: project Dockview state onto the chrome
 * subtree instead of matching overlay DOM classes. */
export function useDockviewPaneFloating(api: DockviewPanelApi): boolean {
	const subscribe = useCallback(
		(notify: () => void) => {
			if (typeof api.onDidLocationChange !== "function") return () => {};
			const disposable = api.onDidLocationChange(notify);
			return () => disposable.dispose();
		},
		[api],
	);
	const getSnapshot = useCallback(
		() => api.location?.type === "floating",
		[api],
	);

	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
