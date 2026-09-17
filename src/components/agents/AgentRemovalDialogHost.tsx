import { useSyncExternalStore } from "react";
import { KillAgentDialog } from "@/components/agents/KillAgentDialog";
import {
  agentRemovalDialogSnapshot,
  closeAgentRemovalDialog,
  subscribeAgentRemovalDialog,
} from "@/lib/agents/agentRemovalDialog";

export function AgentRemovalDialogHost() {
  const request = useSyncExternalStore(
    subscribeAgentRemovalDialog,
    agentRemovalDialogSnapshot,
    agentRemovalDialogSnapshot,
  );
  if (!request) return null;

  return (
    <KillAgentDialog
      key={request.requestId}
      agent={request.agent}
      onClose={() => closeAgentRemovalDialog(request.requestId)}
    />
  );
}
