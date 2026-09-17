import { useCallback, useSyncExternalStore } from "react";
import type { DockviewPanelApi } from "dockview-react";

/**
 * Projects Dockview's group ownership onto the small pane chrome subtree.
 *
 * Consumers should render active presentation from this value instead of
 * matching `.dv-active-group` through the terminal DOM. The latter makes an
 * ancestor class change invalidate every xterm row in WebKit.
 */
export function useDockviewGroupActive(api: DockviewPanelApi): boolean {
  const subscribe = useCallback(
    (notify: () => void) => {
      if (typeof api.onDidActiveGroupChange !== "function") return () => {};
      const disposable = api.onDidActiveGroupChange(notify);
      return () => disposable.dispose();
    },
    [api],
  );
  const getSnapshot = useCallback(() => api.isGroupActive === true, [api]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
