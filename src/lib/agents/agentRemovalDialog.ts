import { createBroadcast } from "@/lib/state/broadcast";
import type { Agent } from "@/types";

export interface AgentRemovalDialogRequest {
  requestId: number;
  agent: Agent;
}

type Listener = () => void;

let nextRequestId = 1;
let request: AgentRemovalDialogRequest | null = null;
const changed = createBroadcast<void>();

function publish(): void {
  changed.publish();
}

export function openAgentRemovalDialog(agent: Agent): void {
  request = {
    requestId: nextRequestId++,
    // The registration can disappear while cleanup continues. Keep the exact
    // confirmation snapshot so the app-level dialog survives that boundary.
    agent: { ...agent },
  };
  publish();
}

export function closeAgentRemovalDialog(requestId: number): void {
  if (request?.requestId !== requestId) return;
  request = null;
  publish();
}

export function agentRemovalDialogSnapshot(): AgentRemovalDialogRequest | null {
  return request;
}

export function subscribeAgentRemovalDialog(listener: Listener): () => void {
  return changed.subscribe(listener);
}
