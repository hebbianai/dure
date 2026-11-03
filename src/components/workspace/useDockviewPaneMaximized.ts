import type { DockviewApi, DockviewPanelApi } from "dockview-react";
import { useCallback, useSyncExternalStore } from "react";

/** Whether this pane covers the layout ("maximized"), could ("restored"), or
 * cannot because it is not a grid pane (null). Mirrors useDockviewPaneFloating:
 * project Dockview state onto the chrome subtree. */
export function useDockviewPaneMaximized(
	api: DockviewPanelApi,
	containerApi: DockviewApi,
): "maximized" | "restored" | null {
	const subscribe = useCallback(
		(notify: () => void) => {
			const maximized =
				typeof containerApi.onDidMaximizedGroupChange === "function"
					? containerApi.onDidMaximizedGroupChange(notify)
					: undefined;
			const location =
				typeof api.onDidLocationChange === "function"
					? api.onDidLocationChange(notify)
					: undefined;
			return () => {
				maximized?.dispose();
				location?.dispose();
			};
		},
		[api, containerApi],
	);
	const getSnapshot = useCallback(() => {
		if (api.location?.type !== "grid") return null;
		return api.isMaximized() ? "maximized" : "restored";
	}, [api]);

	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
