import { providerFromCommand } from "@/lib/agents/providers";
import { useStore } from "@/store";

/** Record non-semantic prompt presentation. Runtime and conversation identity
 * are projected separately by the Host report. */
export function handleActivity(params: Record<string, unknown>): void {
  const state = useStore.getState();
  const sessionId = params.sessionId ? String(params.sessionId) : "";
  const text = params.text ? String(params.text) : "";
  if (!sessionId || !text) return;
  const provider = providerFromCommand(
    params.provider ? String(params.provider) : "",
  );
  if (provider) {
    state.setSessionAgentPin(sessionId, provider);
  }
  state.setSessionActivity(sessionId, text);
}
