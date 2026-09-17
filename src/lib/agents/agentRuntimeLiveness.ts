import type { HmuxAgentRuntimeState, HmuxSessionSummary } from "@/lib/ipc";
import type { Agent, AgentActivity } from "@/types";

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
