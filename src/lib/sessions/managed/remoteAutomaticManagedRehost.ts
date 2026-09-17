import {
	hmuxManagedGeneration,
	sameHmuxManagedGeneration,
} from "@/lib/hmux/identity/hmuxManagedGeneration";
import type { RemoteHmuxCatalogReceiptV1 } from "@/lib/hmux/remote/remoteHmuxBroker";
import type { HmuxSessionSummary } from "@/lib/ipc";
import type { Agent } from "@/types";

/** Projects a fresh remote catalog onto the already-attached session summary.
 * The catalog owns installed-build and process-liveness facts; the attachment
 * owns protocol, output, and input facts. Neither source is widened to claim a
 * fact it cannot observe. */
export function projectRemoteAutomaticManagedRehostSession(
	agent: Agent,
	attached: HmuxSessionSummary | undefined,
	catalog: RemoteHmuxCatalogReceiptV1,
): HmuxSessionSummary | undefined {
	const binding = agent.runtimeBinding;
	if (
		binding?.runtime !== "hmux_managed_v1" ||
		binding.source !== "ssh" ||
		binding.hostId !== catalog.hostId ||
		binding.sessionId !== agent.sessionId ||
		!binding.stopFence ||
		!attached ||
		attached.sessionId !== binding.sessionId ||
		attached.workspaceId !== binding.workspaceId ||
		attached.sessionClass !== "managed" ||
		attached.runtimeHost !== binding.hostId ||
		!sameHmuxManagedGeneration(attached.stopFence, binding.stopFence)
	) {
		return undefined;
	}
	const matches = catalog.sessions.filter(
		(session) =>
			session.sessionId === binding.sessionId &&
			session.workspaceId === binding.workspaceId,
	);
	if (matches.length !== 1) return undefined;
	const remote = matches[0];
	const remoteGeneration = hmuxManagedGeneration(remote);
	if (
		remote.sessionClass !== "managed" ||
		remote.providerId !== agent.provider ||
		remote.lifecycle !== "ready" ||
		remote.hostLiveness !== "live" ||
		!remote.gatewayBuildId ||
		!sameHmuxManagedGeneration(remoteGeneration, binding.stopFence) ||
		!attached.hostBuildVersion
	) {
		return undefined;
	}
	return {
		...attached,
		health:
			attached.hostBuildVersion === remote.gatewayBuildId
				? "current_healthy"
				: "compatible_old_healthy",
	};
}
