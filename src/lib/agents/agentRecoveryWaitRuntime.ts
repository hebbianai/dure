// When each Agent continues by itself after its usage limit resets, as its
// backend's recovery reports it. The backend's recovery record owns the wait;
// this window keeps the latest list of every backend that owns an Agent and
// publishes the merged waits to the attention store, where the needs-person
// authority and the Agent rows read them. Panes never poll, and nothing here
// starts, stops or answers a recovery.
import type { RecoveryWait } from "@/lib/agents/accountRecoveryContract";
import { useAgentAttention } from "@/lib/agents/agentAttentionStore";
import { agentRuntimeTransitionBackendProfileId } from "@/lib/agents/agentRuntimeProfileSwitch";
import { createAccountRecoveryClient } from "@/lib/ipc/dureAccountRecovery";
import { type AppState, useStore } from "@/store";

/** A wait begins when a limit stops a turn and ends when recovery moves on,
 * neither of which any client is told about, so a slow backstop reads every
 * backend's list. It is one small read per backend. */
export const RECOVERY_WAIT_REFRESH_MS = 15_000;

type RecoveryWaitState = Pick<AppState, "agents" | "projects">;

export interface AgentRecoveryWaitRuntimeDependencies {
	readState: () => RecoveryWaitState;
	/** Called when the Agents or the projects they belong to change. */
	subscribe: (listener: () => void) => () => void;
	readWaits: (backendProfileId: string) => Promise<RecoveryWait[]>;
	publish: (waits: Record<string, number>) => void;
	setInterval: (
		listener: () => void,
		intervalMs: number,
	) => ReturnType<typeof setInterval>;
	clearInterval: (timer: ReturnType<typeof setInterval>) => void;
}

const defaultDependencies: AgentRecoveryWaitRuntimeDependencies = {
	readState: () => useStore.getState(),
	subscribe: (listener) =>
		useStore.subscribe((state, previous) => {
			if (
				state.agents !== previous.agents ||
				state.projects !== previous.projects
			) {
				listener();
			}
		}),
	readWaits: (backendProfileId) =>
		createAccountRecoveryClient(backendProfileId).waits(),
	publish: (waits) => useAgentAttention.getState().setRecoveryWaits(waits),
	setInterval: (listener, intervalMs) => setInterval(listener, intervalMs),
	clearInterval: (timer) => clearInterval(timer),
};

/** Each Agent recovery can continue, with the backend profile that owns its
 * runtime: the same route a runtime change or a Chat turn takes. */
function agentProfiles(state: RecoveryWaitState): Map<string, string> {
	const profiles = new Map<string, string>();
	for (const agent of state.agents) {
		const profileId = agentRuntimeTransitionBackendProfileId(
			agent,
			state.projects.find((project) => project.id === agent.projectId),
		);
		if (profileId) profiles.set(agent.id, profileId);
	}
	return profiles;
}

/** The backend profiles whose waits this window reads, in a stable order. */
export function recoveryWaitProfiles(state: RecoveryWaitState): string[] {
	return [...new Set(agentProfiles(state).values())].sort();
}

/** Agent id → when it continues. A wait counts only from the backend that
 * owns the Agent, so a list never speaks for another backend's Agents. */
export function mergeRecoveryWaits(
	state: RecoveryWaitState,
	reported: ReadonlyMap<string, readonly RecoveryWait[]>,
): Record<string, number> {
	const waits: Record<string, number> = {};
	for (const [agentId, profileId] of agentProfiles(state)) {
		const wait = reported
			.get(profileId)
			?.find((entry) => entry.agentId === agentId);
		if (wait) waits[agentId] = wait.resumeAtMs;
	}
	return waits;
}

export function installAgentRecoveryWaitRuntime(
	deps: AgentRecoveryWaitRuntimeDependencies = defaultDependencies,
): () => void {
	let disposed = false;
	const reported = new Map<string, readonly RecoveryWait[]>();
	const inflight = new Set<string>();

	const publish = () => {
		if (!disposed) deps.publish(mergeRecoveryWaits(deps.readState(), reported));
	};

	const read = (profileId: string) => {
		if (inflight.has(profileId)) return;
		inflight.add(profileId);
		// A read that throws before its promise counts as a failed read.
		void Promise.resolve()
			.then(() => deps.readWaits(profileId))
			.then(
				(waits) => {
					reported.set(profileId, waits);
				},
				// A backend that cannot be reached, or that predates the list,
				// reports no wait: its Agents read as their Hosts show them.
				() => {
					reported.delete(profileId);
				},
			)
			.finally(() => {
				inflight.delete(profileId);
				publish();
			});
	};

	let profilesKey: string | undefined;
	const refresh = () => {
		if (disposed) return;
		const profiles = recoveryWaitProfiles(deps.readState());
		profilesKey = profiles.join("\n");
		for (const profileId of reported.keys()) {
			if (!profiles.includes(profileId)) reported.delete(profileId);
		}
		for (const profileId of profiles) read(profileId);
		publish();
	};
	// Agent records change often; only a backend this window has not read
	// yet needs a read now. Otherwise the lists in hand are merged again.
	const changed = () => {
		if (disposed) return;
		const key = recoveryWaitProfiles(deps.readState()).join("\n");
		if (key === profilesKey) publish();
		else refresh();
	};

	const unsubscribe = deps.subscribe(changed);
	const timer = deps.setInterval(refresh, RECOVERY_WAIT_REFRESH_MS);
	refresh();

	return () => {
		if (disposed) return;
		unsubscribe();
		deps.clearInterval(timer);
		deps.publish({});
		disposed = true;
	};
}
