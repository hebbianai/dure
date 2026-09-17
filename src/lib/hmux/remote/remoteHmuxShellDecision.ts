import type { RemoteShellHostDraft } from "@/lib/hmux/remote/remoteHmuxShellRegistration";
import { cliRequestBeginDecision } from "@/lib/ipc";
import { useStore } from "@/store";

/** Null means this delivery owns no decision and must not claim completion. */
export async function requestRemoteShellHostRegistration(
	requestId: string,
	candidate: RemoteShellHostDraft,
): Promise<boolean | null> {
	const lifetimeMs = await cliRequestBeginDecision(requestId);
	if (lifetimeMs === null) return null;
	return useStore
		.getState()
		.requestSshRegistrationDecision(requestId, candidate, lifetimeMs);
}
