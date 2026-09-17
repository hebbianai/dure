import { emit } from "@tauri-apps/api/event";
import type { ManagedAgentRehostSyncPayload } from "@/lib/sessions/managed/managedAgentRehostSyncContract";
import { MANAGED_AGENT_REHOSTED_EVENT } from "@/lib/sessions/managed/managedAgentRehostSyncContract";

/** Notify other WebViews after commit, without making runtime completion wait
 * for replaceable presentation. A missed event recovers through runtime inspection,
 * never by repeating the replacement. */
export function publishManagedAgentRehostProjection(
	payload: ManagedAgentRehostSyncPayload,
	broadcast: typeof emit = emit,
): void {
	void Promise.resolve()
		.then(() => broadcast(MANAGED_AGENT_REHOSTED_EVENT, payload))
		.catch((error: unknown) => {
			console.warn(
				"[managed rehost publication] Rehost committed, but window notification failed. Refresh a stale window to inspect the current runtime.",
				{
					agentId: payload.agentId,
					operationId: payload.operationId,
					sessionId: payload.binding.sessionId,
				},
				error,
			);
		});
}
