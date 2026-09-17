// SshHostDialogs' designated store-wiring point (cluster wiring hook). Every
// global-store subscription the add/edit host dialog and the remote project
// browser need lives here; the components consume the returned values and
// keep rendering only. Each selector stays its own useStore subscription so
// rerender semantics match the previous inline wiring exactly.
import { useStore } from "@/store";

export function useSshRegistrationDecision() {
  return useStore((state) => state.sshRegistrationDecisions[0]);
}

/** Store wiring for the remote folder browser dialog. */
export function useAddRemoteProjectDialogState(hostId: string) {
  const ensureProjectForPath = useStore((s) => s.ensureProjectForPath);
  const host = useStore((s) => s.sshHosts.find((h) => h.id === hostId));
  return { ensureProjectForPath, host };
}
