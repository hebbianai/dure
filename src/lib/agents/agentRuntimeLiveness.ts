import { sameHmuxManagedGeneration } from "@/lib/hmux/identity/hmuxManagedGeneration";
import type { HmuxAgentRuntimeState, HmuxSessionSummary } from "@/lib/ipc";
import type { Agent, AgentActivity, AgentRuntimeBindingV1 } from "@/types";

/** A managed Agent's Host binding. */
type ManagedBinding = Extract<AgentRuntimeBindingV1, { runtime: "hmux_managed_v1" }>;

/** A complete Hmux summary is exited when either the projected lifecycle or
 * its underlying manifest/runtime health has reached the terminal state. */
export function isExitedHmuxSession(summary: HmuxSessionSummary): boolean {
	return (
		summary.lifecycle === "exited" ||
		summary.manifestLifecycle === "exited" ||
		summary.health === "exited"
	);
}

/** In-memory activity is a spawn-gap fence only in the positive direction.
 * Missing or exited observations make no liveness claim after a reload. */
export function hasPositiveAgentRuntimeObservation(input: {
	agent: Agent;
	agentActivity: Readonly<Partial<Record<string, AgentActivity>>>;
	sessionAgentRuntimeState: Readonly<
		Record<string, HmuxAgentRuntimeState | undefined>
	>;
}): boolean {
	const activity = input.agentActivity[input.agent.id];
	const runtimeState = input.sessionAgentRuntimeState[input.agent.sessionId];
	return (
		(activity !== undefined && activity !== "exited") ||
		(runtimeState !== undefined && runtimeState.lifecycle !== "exited")
	);
}

/** The census entry for a managed binding's exact session, if it lists one. */
export function exactCensusSession(
	sessions: readonly HmuxSessionSummary[],
	binding: Pick<ManagedBinding, "sessionId" | "workspaceId">,
): HmuxSessionSummary | undefined {
	return sessions.find(
		(session) =>
			session.sessionId === binding.sessionId &&
			session.workspaceId === binding.workspaceId,
	);
}

/** Whether a complete census proves a managed binding's session ended: it
 * lacks the session, or lists it exited in this binding's own generation.
 * Another generation in the same place says nothing about this one. */
export function censusProvesSessionEnded(
	sessions: readonly HmuxSessionSummary[],
	binding: Pick<ManagedBinding, "sessionId" | "workspaceId"> & {
		readonly stopFence: NonNullable<ManagedBinding["stopFence"]>;
	},
): boolean {
	const session = exactCensusSession(sessions, binding);
	return (
		session === undefined ||
		(isExitedHmuxSession(session) &&
			session.terminalEpoch === binding.stopFence.terminalEpoch &&
			sameHmuxManagedGeneration(binding.stopFence, session.stopFence))
	);
}
