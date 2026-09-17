// LocationManagerDialog's designated store-wiring point (cluster wiring
// hook). Every global-store subscription the dialog needs lives here; the
// component consumes the returned values and keeps rendering only. Each
// selector stays its own useStore subscription so rerender semantics match
// the previous inline wiring exactly.
import { useStore } from "@/store";

export function useLocationManagerDialogState() {
  const projects = useStore((state) => state.projects);
  const pinnedProjectIds = useStore((state) => state.pinnedProjects);
  const sshHosts = useStore((state) => state.sshHosts);
  const activeSpaceId = useStore((state) => state.activeSpaceId);
  const togglePin = useStore((state) => state.toggleProjectPin);
  const moveProject = useStore((state) => state.moveProject);
  return {
    projects,
    pinnedProjectIds,
    sshHosts,
    activeSpaceId,
    togglePin,
    moveProject,
  };
}
