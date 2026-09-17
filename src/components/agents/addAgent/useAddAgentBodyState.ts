// AddAgentBody's designated store-wiring point (cluster wiring hook). Every
// global-store subscription the add-agent dialog body needs lives here; the
// component consumes the returned values and keeps rendering only. Each
// selector stays its own useStore subscription so rerender semantics match
// the previous inline wiring exactly.
import { addAgent } from "@/lib/agents/agentRegistration";
import { useStore } from "@/store";
import type { Provider } from "@/types";

export function useAddAgentBodyState() {
  const agents = useStore((s) => s.agents);
  const sshHosts = useStore((s) => s.sshHosts);
  const ensureProjectForPath = useStore((s) => s.ensureProjectForPath);
  const activeSpaceId = useStore((s) => s.activeSpaceId);
  return { agents, sshHosts, addAgent, ensureProjectForPath, activeSpaceId };
}

// Call-time store reads below match the previous inline useStore.getState()
// calls exactly — they deliberately do not subscribe.

/** Hosts read at load time by the branch/worktree effect — subscribing would
 *  rerun that load on every host-list change even for local projects. */
export function readSshHosts() {
  return useStore.getState().sshHosts;
}

/** The space that will host the new agent's pane, resolved at submit time. */
export function findSpaceById(spaceId: string) {
  return useStore.getState().spaces.find((space) => space.id === spaceId);
}

/** The agent projection a canonical run just registered, read at submit time. */
export function findAgentById(agentId: string) {
  return useStore.getState().agents.find((candidate) => candidate.id === agentId);
}

/** Per-provider skip-permissions default, read at submit time. */
export function readSkipPermissions(provider: Provider) {
  return useStore.getState().skipPermissions[provider];
}
