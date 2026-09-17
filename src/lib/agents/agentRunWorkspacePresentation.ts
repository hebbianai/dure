import { defaultWorktreePath } from "@/lib/scm/worktrees/worktreePlan";
import type { Agent, Project, Provider } from "@/types";

export type AgentRunReceiptWorktree =
	| { kind: "project_root" }
	| { kind: "existing_checkout"; branch: string; rootPath: string }
	| {
			kind: "dedicated";
			branch: string;
			directoryName: string;
			rootPath?: string;
	  }
	| {
			kind: "existing_workspace";
			sourceAgentId: string;
			rootPath: string;
	  };

export type AgentRunPresentationWorktree =
	| Exclude<AgentRunReceiptWorktree, { kind: "existing_workspace" }>
	| (Extract<AgentRunReceiptWorktree, { kind: "existing_workspace" }> & {
			branch: string;
	  });

class AgentRunWorkspacePresentationError extends Error {
	readonly code = "client_agent_source_authority_changed";

	constructor() {
		super("existing workspace source changed before presentation");
		this.name = "AgentRunWorkspacePresentationError";
	}
}

/** Enriches a backend-owned workspace receipt with the only IDE presentation
 * fact it does not carry. The snapshot is taken before the backend side effect
 * and remains valid after the source pane is closed. */
export function agentRunPresentationWorktree(
	worktree: AgentRunReceiptWorktree,
	existingWorkspace?: { sourceAgentId: string; branch: string },
): AgentRunPresentationWorktree {
	if (worktree.kind !== "existing_workspace") return worktree;
	if (
		!existingWorkspace ||
		existingWorkspace.sourceAgentId !== worktree.sourceAgentId
	) {
		throw new AgentRunWorkspacePresentationError();
	}
	return { ...worktree, branch: existingWorkspace.branch };
}

/** Normalizes an external presentation receipt at entry, before any mount,
 * runtime inspection, or project-resolution await can invalidate the source. */
export function snapshotAgentRunPresentationWorktree(
	worktree: AgentRunReceiptWorktree,
	agents: readonly Agent[],
	project: Pick<Project, "id">,
	provider: Provider,
): AgentRunPresentationWorktree {
	if (worktree.kind !== "existing_workspace") return worktree;
	const source = agents.find(
		(candidate) => candidate.id === worktree.sourceAgentId,
	);
	if (
		!source ||
		source.projectId !== project.id ||
		source.provider !== provider ||
		source.worktreePath !== worktree.rootPath
	) {
		throw new AgentRunWorkspacePresentationError();
	}
	return agentRunPresentationWorktree(worktree, {
		sourceAgentId: source.id,
		branch: source.branch,
	});
}

export function projectAgentRunWorkspace(
	worktree: AgentRunPresentationWorktree,
	projectPath: string,
): { path: string; branch: string } {
	if (worktree.kind === "project_root") {
		return { path: projectPath, branch: "" };
	}
	if (worktree.kind === "dedicated") {
		return {
			path:
				worktree.rootPath ??
				defaultWorktreePath(projectPath, worktree.directoryName),
			branch: worktree.branch,
		};
	}
	return { path: worktree.rootPath, branch: worktree.branch };
}
