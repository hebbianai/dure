import { isCanonicalDecimalString } from "@/lib/decimalString";
import { sameHmuxManagedGeneration } from "@/lib/hmux/identity/hmuxManagedGeneration";
import type {
	HmuxAgentRuntimeState,
	HmuxManagedIdleReplacementGuardV1,
	HmuxSessionSummary,
} from "@/lib/ipc";
import type { HmuxPaneHealth } from "@/lib/terminal/terminalHealth";
import type { Agent } from "@/types";

type AutomaticManagedRehostBlockReason =
	| "source_identity_mismatch"
	| "conversation_identity_required"
	| "credential_switch_pending"
	| "source_not_old_healthy"
	| "source_not_ready"
	| "source_not_input_capable"
	| "idle_replacement_guard_unavailable"
	| "runtime_unavailable"
	| "input_working"
	| "runtime_working"
	| "runtime_attention"
	| "pane_unavailable"
	| "pending_output"
	| "visible_desktop";

export interface AutomaticManagedRehostPaneSnapshot {
	desktopId: string;
	panelId: string;
	health: HmuxPaneHealth;
}

export interface AutomaticManagedRehostSnapshot {
	agent: Agent;
	session: HmuxSessionSummary | undefined;
	runtime: HmuxAgentRuntimeState | undefined;
	pane: AutomaticManagedRehostPaneSnapshot | undefined;
	inputWorking: boolean;
	visibleDesktopIds: ReadonlySet<string>;
}

export interface AutomaticManagedRehostCandidate {
	eligible: true;
	/** Exact source generation; a later terminal epoch must dwell again. */
	identity: string;
	agentId: string;
	desktopId: string;
	panelId: string;
	source: "local" | "ssh";
	hostId: string;
	idleReplacementGuard: HmuxManagedIdleReplacementGuardV1;
}

export const HMUX_MANAGED_IDLE_REPLACEMENT_GUARD_CAPABILITY =
	"managed_provider_stop_idle_replacement_guard_v1";

export type AutomaticManagedRehostAssessment =
	| AutomaticManagedRehostCandidate
	| { eligible: false; reason: AutomaticManagedRehostBlockReason };

function blocked(
	reason: AutomaticManagedRehostBlockReason,
): AutomaticManagedRehostAssessment {
	return { eligible: false, reason };
}

/** Unattended replacement is intentionally narrower than manual recovery.
 * Every unknown or partially observed state is a refusal, never an idle guess. */
export function assessAutomaticManagedRehost(
	snapshot: AutomaticManagedRehostSnapshot,
): AutomaticManagedRehostAssessment {
	const { agent, session, runtime, pane } = snapshot;
	const binding = agent.runtimeBinding;
	const supportedLocation =
		(binding?.source === "local" && binding.hostId === "local") ||
		(binding?.source === "ssh" && binding.hostId !== "local");
	if (
		binding?.runtime !== "hmux_managed_v1" ||
		!supportedLocation ||
		binding.sessionId !== agent.sessionId ||
		!session ||
		session.sessionId !== binding.sessionId ||
		session.workspaceId !== binding.workspaceId ||
		session.sessionClass !== "managed"
	) {
		return blocked("source_identity_mismatch");
	}
	if (
		binding.source === "ssh" &&
		(session.runtimeHost !== binding.hostId ||
			!binding.stopFence ||
			!session.stopFence ||
			!sameHmuxManagedGeneration(session.stopFence, binding.stopFence))
	) {
		return blocked("source_identity_mismatch");
	}
	if (!agent.conversationId?.trim()) {
		return blocked("conversation_identity_required");
	}
	if (agent.pendingCredentialSwitch) {
		return blocked("credential_switch_pending");
	}
	if (session.health !== "compatible_old_healthy") {
		return blocked("source_not_old_healthy");
	}
	if (session.lifecycle !== "ready" || session.manifestLifecycle !== "ready") {
		return blocked("source_not_ready");
	}
	if (session.inputAllowed !== true || session.detachOnly === true) {
		return blocked("source_not_input_capable");
	}
	if (
		!session.capabilities.includes(
			HMUX_MANAGED_IDLE_REPLACEMENT_GUARD_CAPABILITY,
		)
	) {
		return blocked("idle_replacement_guard_unavailable");
	}
	if (
		!runtime ||
		runtime.terminalEpoch !== session.terminalEpoch ||
		runtime.lifecycle !== "running" ||
		!isCanonicalDecimalString(runtime.revision) ||
		!isCanonicalDecimalString(runtime.observedThroughOutputSeq) ||
		!isCanonicalDecimalString(session.outputSeq)
	) {
		return blocked("runtime_unavailable");
	}
	if (snapshot.inputWorking) return blocked("input_working");
	if (runtime.activity !== "waiting") return blocked("runtime_working");
	if (runtime.attention !== "none") return blocked("runtime_attention");
	if (runtime.observedThroughOutputSeq !== session.outputSeq) {
		return blocked("pending_output");
	}
	if (!pane?.panelId || !pane.desktopId) {
		return blocked("pane_unavailable");
	}
	if (
		pane.health.state !== "live" ||
		pane.health.terminalEpoch !== session.terminalEpoch ||
		pane.health.receivedSequence !== session.outputSeq ||
		pane.health.presentedSequence !== pane.health.receivedSequence
	) {
		return blocked("pending_output");
	}
	if (snapshot.visibleDesktopIds.has(pane.desktopId)) {
		return blocked("visible_desktop");
	}
	return {
		eligible: true,
		identity: JSON.stringify([
			binding.hostId,
			session.workspaceId,
			session.sessionId,
			session.terminalEpoch,
		]),
		agentId: agent.id,
		desktopId: pane.desktopId,
		panelId: pane.panelId,
		source: binding.source,
		hostId: binding.hostId,
		idleReplacementGuard: {
			runtimeRevision: runtime.revision,
			outputSequence: session.outputSeq,
			providerId: agent.provider,
			conversationId: agent.conversationId.trim(),
		},
	};
}
