import type { AgentRunReceiptWorktree } from "@/lib/agents/agentRunWorkspacePresentation";
import type { ExistingWorktreeRef } from "@/lib/ipc/git";
import { asRecord as record } from "@/lib/payloadGuards";
import {
	isGitCheckoutInstanceV1,
	sameGitCheckoutInstanceV1,
} from "@/lib/scm/worktrees/gitCheckoutInstance";
import type { GitCheckoutInstanceV1 } from "@/lib/scm/worktrees/gitCheckoutProtocol";
import { worktreeDirName } from "@/lib/scm/worktrees/worktreePlan";

export type DureAgentRunWorktreeV1 =
	| { kind: "project_root" }
	| { kind: "existing_checkout"; reference: ExistingWorktreeRef }
	| {
			kind: "dedicated";
			branch: string;
			baseCommitSha?: string;
			branchMode?: "create" | "existing";
			checkoutPath?: string;
	  }
	| {
			kind: "existing_workspace";
			sourceAgentId: string;
			workspaceId: string;
	  };

export function validAbsolutePath(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.startsWith("/") &&
		value.length <= 4096 &&
		!Array.from(value).some((character) => {
			const codePoint = character.codePointAt(0);
			return (
				codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
			);
		})
	);
}

export type WireWorktree =
	| { kind: "project_root" }
	| { kind: "existing_checkout"; reference: ExistingWorktreeRef }
	| {
			kind: "dedicated";
			branch: string;
			base_commit_sha?: string;
			branch_mode?: "create" | "existing";
			checkout_path?: string;
	  }
	| {
			kind: "existing_workspace";
			source_agent_id: string;
			workspace_id: string;
	  };

export type ParsedWorktree =
	| { kind: "project_root" }
	| {
			kind: "existing_checkout";
			instance: GitCheckoutInstanceV1;
			branch: string;
			base_commit_sha: string;
	  }
	| {
			kind: "dedicated";
			branch: string;
			base_commit_sha: string;
			branch_mode?: "create" | "existing";
			checkout_path?: string;
	  }
	| {
			kind: "existing_workspace";
			source_agent_id: string;
			workspace_id: string;
			workspace_root: string;
	  };

export function completedWorktree(
	planned: ParsedWorktree,
	workspaceId: string,
	workspaceEvidence: Record<string, unknown>,
	checkoutRegistration: unknown,
): AgentRunReceiptWorktree | null {
	let worktree: AgentRunReceiptWorktree;
	if (planned.kind === "project_root") {
		if (
			workspaceEvidence.disposition !== "adopted_existing" ||
			workspaceEvidence.lease !== undefined
		) {
			return null;
		}
		worktree = { kind: "project_root" };
	} else if (planned.kind === "dedicated") {
		const lease = record(workspaceEvidence.lease);
		const directoryName = worktreeDirName(planned.branch);
		if (
			workspaceEvidence.disposition !== "created_dure_owned" ||
			!lease ||
			lease.lease_id !== `workspace-lease:${workspaceId}` ||
			lease.retirement_id !== `workspace-retire:${workspaceId}` ||
			lease.directory_name !== directoryName
		) {
			return null;
		}
		worktree = {
			kind: "dedicated",
			branch: planned.branch,
			directoryName,
		};
		const registration = record(checkoutRegistration);
		const rootPath = record(registration?.instance)?.canonicalPath;
		if (validAbsolutePath(rootPath)) worktree.rootPath = rootPath;
		else if (planned.checkout_path !== undefined) return null;
	} else if (planned.kind === "existing_checkout") {
		const instance = record(checkoutRegistration)?.instance;
		if (
			workspaceEvidence.disposition !== "adopted_existing" ||
			workspaceEvidence.lease !== undefined ||
			!isGitCheckoutInstanceV1(instance) ||
			!sameGitCheckoutInstanceV1(instance, planned.instance)
		)
			return null;
		worktree = {
			kind: "existing_checkout",
			rootPath: instance.canonicalPath,
			branch: planned.branch,
		};
	} else {
		if (
			workspaceEvidence.disposition !== "adopted_existing" ||
			workspaceEvidence.lease !== undefined ||
			workspaceId !== planned.workspace_id
		) {
			return null;
		}
		worktree = {
			kind: "existing_workspace",
			sourceAgentId: planned.source_agent_id,
			rootPath: planned.workspace_root,
		};
	}
	return worktree;
}

export function wireWorktree(worktree: DureAgentRunWorktreeV1): WireWorktree {
	if (worktree.kind === "project_root") return { kind: "project_root" };
	if (worktree.kind === "existing_checkout")
		return { kind: "existing_checkout", reference: { ...worktree.reference } };
	if (worktree.kind === "existing_workspace") {
		return {
			kind: "existing_workspace",
			source_agent_id: worktree.sourceAgentId,
			workspace_id: worktree.workspaceId,
		};
	}
	return {
		kind: "dedicated",
		branch: worktree.branch,
		...(worktree.branchMode !== undefined
			? { branch_mode: worktree.branchMode }
			: {}),
		...(worktree.checkoutPath !== undefined
			? { checkout_path: worktree.checkoutPath }
			: {}),
		...(worktree.baseCommitSha
			? { base_commit_sha: worktree.baseCommitSha }
			: {}),
	};
}
