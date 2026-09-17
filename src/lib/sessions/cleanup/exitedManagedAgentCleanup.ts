import {
	hasPositiveAgentRuntimeObservation,
	isExitedHmuxSession,
} from "@/lib/agents/agentRuntimeLiveness";
import { isLegacyAgentWriterTarget } from "@/lib/agents/agentWriterPartition";
import { sameHmuxManagedGeneration } from "@/lib/hmux/identity/hmuxManagedGeneration";
import type { HmuxAgentRuntimeState, HmuxSessionSummary } from "@/lib/ipc";
import {
	bindingForAgent,
	type HmuxManagedPaneBindingV1,
} from "@/lib/terminal/terminalBinding";
import type { Agent, AgentActivity, Project } from "@/types";

type ExitedManagedAgentSourceState = "absent" | "exited" | "stale";

export interface ExitedManagedAgentCleanupCandidate {
	agentId: string;
	agentName: string;
	projectName: string;
	binding: HmuxManagedPaneBindingV1;
	sourceState: ExitedManagedAgentSourceState;
	terminalEpoch?: string;
}

export interface ExitedManagedAgentCleanupPlan {
	candidates: ExitedManagedAgentCleanupCandidate[];
	protectedManagedCount: number;
}

/**
 * A fresh WebView has no in-memory exit observation for old registrations.
 * Discovery absence is still safe to offer for presentation-only cleanup as
 * long as no current activity/runtime observation says the Agent is alive.
 * Creation writes "connecting" with the registration, fencing the spawn gap.
 */
export function absentManagedAgentCleanupEligibleIds(input: {
	agents: readonly Agent[];
	agentActivity: Readonly<Partial<Record<string, AgentActivity>>>;
	sessionAgentRuntimeState: Readonly<
		Record<string, HmuxAgentRuntimeState | undefined>
	>;
}): ReadonlySet<string> {
	return new Set(
		input.agents.flatMap((agent) => {
			if (!isLegacyAgentWriterTarget(agent)) return [];
			return hasPositiveAgentRuntimeObservation({
				agent,
				agentActivity: input.agentActivity,
				sessionAgentRuntimeState: input.sessionAgentRuntimeState,
			})
				? []
				: [agent.id];
		}),
	);
}

function exactSession(
	sessions: readonly HmuxSessionSummary[],
	binding: HmuxManagedPaneBindingV1,
): HmuxSessionSummary | undefined {
	return sessions.find(
		(session) =>
			session.sessionId === binding.sessionId &&
			session.workspaceId === binding.workspaceId,
	);
}

function isStaleHmuxSession(summary: HmuxSessionSummary): boolean {
	return (
		!isExitedHmuxSession(summary) &&
		(summary.lifecycle === "unavailable" ||
			summary.health === "stale_transport" ||
			summary.health === "generation_changed" ||
			summary.health === "incompatible_protocol" ||
			summary.inputAllowed === false)
	);
}

export function sameExitedManagedAgentCleanupCandidate(
	left: ExitedManagedAgentCleanupCandidate,
	right: ExitedManagedAgentCleanupCandidate,
): boolean {
	return (
		left.agentId === right.agentId &&
		left.sourceState === right.sourceState &&
		left.terminalEpoch === right.terminalEpoch &&
		left.binding.sessionId === right.binding.sessionId &&
		left.binding.workspaceId === right.binding.workspaceId &&
		left.binding.createIdempotencyKey === right.binding.createIdempotencyKey &&
		left.binding.credentialId === right.binding.credentialId &&
		left.binding.credentialGeneration === right.binding.credentialGeneration &&
		sameHmuxManagedGeneration(left.binding.stopFence, right.binding.stopFence)
	);
}

export function planExitedManagedAgentCleanup(input: {
	agents: readonly Agent[];
	projects: readonly Project[];
	sessions: readonly HmuxSessionSummary[];
	absentEligibleAgentIds: ReadonlySet<string>;
}): ExitedManagedAgentCleanupPlan {
	const projectNameById = new Map(
		input.projects.map((project) => [project.id, project.name]),
	);
	const plan: ExitedManagedAgentCleanupPlan = {
		candidates: [],
		protectedManagedCount: 0,
	};
	for (const agent of input.agents) {
		if (!isLegacyAgentWriterTarget(agent)) continue;
		const binding = bindingForAgent(agent, input.projects);
		if (
			binding?.runtime !== "hmux_managed_v1" ||
			binding.source !== "local" ||
			binding.hostId !== "local"
		) {
			continue;
		}
		const source = exactSession(input.sessions, binding);
		if (
			source &&
			binding.stopFence &&
			(!source.stopFence ||
				!sameHmuxManagedGeneration(binding.stopFence, source.stopFence))
		) {
			plan.protectedManagedCount += 1;
			continue;
		}
		if (source && !isExitedHmuxSession(source) && !isStaleHmuxSession(source)) {
			plan.protectedManagedCount += 1;
			continue;
		}
		if (!source && !input.absentEligibleAgentIds.has(agent.id)) {
			plan.protectedManagedCount += 1;
			continue;
		}
		plan.candidates.push({
			agentId: agent.id,
			agentName: agent.name,
			projectName: projectNameById.get(agent.projectId) ?? agent.projectId,
			binding,
			sourceState: source
				? isExitedHmuxSession(source)
					? "exited"
					: "stale"
				: "absent",
			...(source ? { terminalEpoch: source.terminalEpoch } : {}),
		});
	}
	return plan;
}
