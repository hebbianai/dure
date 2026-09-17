import { t } from "@/lib/i18n";

export function observedIdleDuration(ms: number | null): string {
	if (ms === null) return t("common.unknown");
	const days = Math.floor(ms / 86_400_000);
	const hours = Math.floor(ms / 3_600_000) % 24;
	const minutes = Math.floor(ms / 60_000) % 60;
	if (days)
		return [
			t("usage.duration.days", { n: days }),
			t("usage.duration.hours", { n: hours }),
		].join(" ");
	if (hours)
		return [
			t("usage.duration.hours", { n: hours }),
			t("usage.duration.minutes", { n: minutes }),
		].join(" ");
	if (minutes) return t("usage.duration.minutes", { n: minutes });
	return t("usage.cleanup.seconds", { n: Math.floor(ms / 1000) });
}

export function idleObservationState(state: string): string {
	switch (state) {
		case "observing":
			return t("usage.cleanup.observing");
		case "protected":
			return t("usage.cleanup.protected");
		case "hibernate_requested":
			return t("usage.cleanup.requested");
		default:
			return t("common.unknown");
	}
}

export function idleObservationReason(reason: string): string {
	switch (reason) {
		case "agent_runtime_semantic_idle_unavailable":
		case "runtime_idle_source_unsupported":
			return t("usage.cleanup.unsupported");
		case "hmux_controller_input_pending":
			return t("usage.cleanup.inputPending");
		case "hmux_agent_runtime_not_quiescent":
			return t("usage.cleanup.notQuiescent");
		case "runtime_idle_agent_busy":
			return t("usage.cleanup.busy");
		case "runtime_idle_source_not_stable":
			return t("usage.cleanup.notStable");
		case "agent_runtime_provider_conversation_unavailable":
			return t("usage.cleanup.noConversation");
		case "runtime_idle_observer_capacity":
			return t("usage.cleanup.capacity");
		case "runtime_idle_authority_unavailable":
		case "runtime_idle_candidates_unavailable":
		case "runtime_idle_policy_unavailable":
		case "hmux_semantic_idle_observation_unavailable":
		case "hmux_agent_runtime_state_mismatch":
			return t("usage.cleanup.unavailable");
		default:
			return t("usage.cleanup.otherReason");
	}
}
