import {
	agentRemovalRegistrationIdentity,
	sameAgentRemovalTarget,
} from "@/lib/agents/agentRemovalRegistration";
import { sameWorktreeLocation } from "@/lib/scm/worktrees/worktreeLocation";
import type { WorktreeRemovalPlan } from "@/lib/scm/worktrees/worktreeRemoval";
import type { Agent } from "@/types";

export interface AgentRemovalPreview {
	readonly agents: readonly Agent[];
	readonly worktree?: WorktreeRemovalPlan;
	readonly worktreeAlreadyAbsent?: boolean;
}

/** Compares user-confirmed scope; Host admission remains authoritative. */
export function sameAgentRemovalPreview(
	left: AgentRemovalPreview,
	right: AgentRemovalPreview,
): boolean {
	if (left.worktreeAlreadyAbsent && !right.worktreeAlreadyAbsent) return false;
	const leftWorktree = left.worktree;
	const rightWorktree = right.worktree;
	if (Boolean(leftWorktree) !== Boolean(rightWorktree)) return false;
	if (
		leftWorktree &&
		rightWorktree &&
		(leftWorktree.kind !== rightWorktree.kind ||
			leftWorktree.hostId !== rightWorktree.hostId ||
			!sameWorktreeLocation(
				leftWorktree.repo,
				rightWorktree.repo,
				leftWorktree.kind === "ssh" ? "posix" : "native",
			) ||
			!sameWorktreeLocation(
				leftWorktree.wtPath,
				rightWorktree.wtPath,
				leftWorktree.kind === "ssh" ? "posix" : "native",
			))
	) {
		return false;
	}
	if (left.agents.length !== right.agents.length) return false;
	const rightAgents = new Map(
		right.agents.map((candidate) => [candidate.id, candidate] as const),
	);
	return left.agents.every((candidate) => {
		const current = rightAgents.get(candidate.id);
		return Boolean(
			current &&
				sameAgentRemovalTarget(
					current,
					agentRemovalRegistrationIdentity(candidate),
				),
		);
	});
}
