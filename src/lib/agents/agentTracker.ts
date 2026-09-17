import { notifyAgentEvent } from "@/lib/agents/agentAttentionNotifier";
import { t } from "@/lib/i18n";
import {
	clearMaintenanceLaneInterval,
	setMaintenanceLaneInterval,
} from "@/lib/scheduling/maintenanceLaneInterval";
import { useStore } from "@/store";

/**
 * Project Host-owned semantic runtime reports into agent activity and usage
 * statistics. The caller owns this one app-lifetime subscription.
 *
 * The exit notification is a transition, not an observation: it fires only
 * when this app lifetime had the agent as connecting, working or waiting and
 * the Host now reports the process gone. A first observation that is already
 * exited (reload, adopting a dead session) and a newer epoch of a session the
 * store already holds as exited (reattach converging to the exit fact) are
 * baselines, the same rule agentAttentionWatch applies to its episodes.
 */
export function installAgentTracker(): () => void {
	const workStart = new Map<string, number>();
	let pendingActiveMs = 0;
	const flushActiveMs = () => {
		if (pendingActiveMs <= 0) return;
		const dt = pendingActiveMs;
		pendingActiveMs = 0;
		useStore.getState().bumpStats({ activeMs: dt });
	};
	const activeMsFlushTimer = setMaintenanceLaneInterval(
		flushActiveMs,
		30_000,
		"agent-tracker-flush",
	);
	window.addEventListener("pagehide", flushActiveMs);
	const stopWorkingWatch = useStore.subscribe((state, previous) => {
		if (state.agentActivity === previous.agentActivity) return;
		for (const agent of state.agents) {
			const activity = state.agentActivity[agent.id];
			const prior = previous.agentActivity[agent.id];
			if (activity === "working" && prior !== "working") {
				workStart.set(agent.id, Date.now());
			} else if (activity !== "working" && prior === "working") {
				const t0 = workStart.get(agent.id);
				if (t0) {
					workStart.delete(agent.id);
					const dt = Date.now() - t0;
					if (dt > 0 && dt < 6 * 3600_000) pendingActiveMs += dt;
				}
			}
		}
	});

	const stopSemanticStateWatch = useStore.subscribe((state, previous) => {
		if (state.sessionAgentRuntimeState === previous.sessionAgentRuntimeState) {
			return;
		}
		for (const [sessionId, runtime] of Object.entries(
			state.sessionAgentRuntimeState,
		)) {
			const prior = previous.sessionAgentRuntimeState[sessionId];
			if (prior === runtime) continue;

			const agent = state.agents.find(
				(candidate) => candidate.sessionId === sessionId,
			);
			if (runtime.lifecycle === "exited") {
				if (agent) {
					const knownActivity = state.agentActivity[agent.id];
					const observedAlive =
						knownActivity !== undefined && knownActivity !== "exited";
					state.setAgentActivity(agent.id, "exited");
					if (observedAlive) {
						notifyAgentEvent(
							agent.id,
							"exited",
							t("app.notifications.agentProcessExited"),
						);
					}
				}
				continue;
			}

			if (!agent) continue;
			if (runtime.activity === "working") {
				state.setAgentActivity(agent.id, "working");
				continue;
			}

			state.setAgentActivity(agent.id, "waiting");
		}
	});

	return () => {
		stopWorkingWatch();
		clearMaintenanceLaneInterval(activeMsFlushTimer);
		window.removeEventListener("pagehide", flushActiveMs);
		flushActiveMs();
		stopSemanticStateWatch();
	};
}
