// SshPane's designated store-wiring point (cluster wiring hook). Every
// global-store subscription the remote explorer tab needs lives here; the
// component consumes the returned values and keeps rendering only. Each
// selector stays its own useStore subscription so rerender semantics match
// the previous inline wiring exactly.
import { useStore } from "@/store";

export function useSshPaneState() {
  const sshHosts = useStore((s) => s.sshHosts);
  const projects = useStore((s) => s.projects);
  const agents = useStore((s) => s.agents);
  const sshStates = useStore((s) => s.sshStates);
  const activeDesktopId = useStore((s) => s.activeDesktopId);
  return {
    sshHosts,
    projects,
    agents,
    sshStates,
    activeDesktopId,
  };
}
