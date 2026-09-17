// Read the one display-state projection shared by pane chrome, Spaces, and
// notifications. The attention watcher owns its interpretation.

import { useStore } from "@/store";
import { isAgentUnread, useAgentAttention } from "@/lib/agents/agentAttentionStore";
import {
  type AgentDisplayState,
  presentedAgentDisplayState,
} from "@/lib/agents/agentStateModel";
import type { Agent } from "@/types";

export function useAgentDisplayState(agent: Agent): {
  state: AgentDisplayState;
  unread: boolean;
} {
  // Before the app-lifetime watcher publishes its first projection, present
  // the registry lifecycle the store holds; the unobserved default lives in
  // presentedAgentDisplayState with every other surface.
  const activity = useStore((s) => s.agentActivity[agent.id]);
  const resolved = useAgentAttention((s) => s.displayStates[agent.id]);
  const episode = useAgentAttention((s) => s.episodes[agent.id] ?? 0);
  const acked = useAgentAttention((s) => s.acks[agent.id] ?? 0);
  return {
    state: presentedAgentDisplayState(resolved, activity),
    unread: isAgentUnread({ [agent.id]: episode }, { [agent.id]: acked }, agent.id),
  };
}

/** Store wiring for the native reply presentation shared by docked and
 * detached panes. Host state remains the same observation used by the chrome. */
export function useNativeAgentResponseState(agent: Agent) {
  const enabled = useStore((s) => s.uiPrefs.agentFinalResponseOnly === true);
  const runtime = useStore((s) => s.sessionAgentRuntimeState[agent.sessionId]);
  return { enabled, runtime, ...useAgentDisplayState(agent) };
}
