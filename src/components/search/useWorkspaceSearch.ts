import { useEffect, useMemo, useSyncExternalStore } from "react";
import { createWorkspaceSearchController, type WorkspaceSearchTarget } from "@/lib/search/workspaceSearchController";
import { runWorkspaceCommand } from "@/lib/workspace/workspaceCommand";

/** React owns target selection and observation cleanup; the controller owns requests. */
export function useWorkspaceSearch(target: WorkspaceSearchTarget | null) {
  const cwd = target?.cwd;
  const source = target?.source;
  const hostId = target?.hostId;
  const controller = useMemo(() => createWorkspaceSearchController(
    cwd !== undefined && source ? { cwd, source, hostId } : null,
    runWorkspaceCommand,
  ), [cwd, source, hostId]);
  useEffect(() => () => controller.clear(), [controller]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  return { ...state, controller };
}
