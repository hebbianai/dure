import {
	captureGitCheckoutInstance,
	locateGitCheckoutPaths,
	prepareRemoteGitCheckoutHelper,
	removeGitCheckoutInstance,
} from "@/lib/ipc/git";
import { prepareTrustedSshTarget, sshExecOnce } from "@/lib/ipc/sessions";
import type {
	GitCheckoutInstanceV1,
	GitCheckoutLocationV1,
	GitCheckoutPathAbsentV1,
	GitCheckoutRemovalPolicyV1,
	GitCheckoutRemovalReceiptV1,
	GitCheckoutRemoveCommandV1,
} from "@/lib/scm/worktrees/gitCheckoutInstance";
import {
	parseRemoteGitCheckoutCapture,
	parseRemoteGitCheckoutLocations,
	parseRemoteGitCheckoutRemoval,
	type RemoteGitCheckoutHelperPath,
	remoteGitCheckoutCaptureExecution,
	remoteGitCheckoutLocationsExecution,
	remoteGitCheckoutRemovalExecution,
} from "@/lib/scm/worktrees/remoteGitCheckoutHelper";
import type {
	WorktreeAgent,
	WorktreeProject,
	WorktreeRemovalPlan,
	WorktreeRemovalScope,
} from "@/lib/scm/worktrees/worktreeRemoval";
import type { TrustedSshTargetV1 } from "@/lib/ssh/trustedSshTarget";
import { sessionKindExecutionProfile } from "@/lib/terminal/sessionKindExecutionProfile";
import type { SshHostConfig } from "@/types";

export type PreparedAgentWorktreeRemoval =
	| {
			readonly transport: "local";
			readonly plan: WorktreeRemovalPlan;
			readonly instance: GitCheckoutInstanceV1;
	  }
	| {
			readonly transport: "ssh";
			readonly plan: WorktreeRemovalPlan;
			readonly instance: GitCheckoutInstanceV1;
			readonly helperPath: RemoteGitCheckoutHelperPath;
			readonly sshTarget: TrustedSshTargetV1;
	  };

const CONFIRMED_AGENT_WORKTREE_REMOVAL_POLICY: GitCheckoutRemovalPolicyV1 =
	"discard_changes";

function remoteHost(
	plan: WorktreeRemovalPlan,
	hosts: readonly SshHostConfig[],
): SshHostConfig | undefined {
	return plan.kind === "ssh"
		? hosts.find((candidate) => candidate.id === plan.hostId)
		: undefined;
}

export async function prepareAgentWorktreeRemoval(
	plan: WorktreeRemovalPlan,
	hosts: readonly SshHostConfig[],
): Promise<PreparedAgentWorktreeRemoval | GitCheckoutPathAbsentV1> {
	if (plan.kind === "local") {
		try {
			const instance = await captureGitCheckoutInstance(plan.repo, plan.wtPath);
			return { transport: "local", plan, instance };
		} catch (error) {
			const [location] = await locateGitCheckoutPaths([plan.wtPath]);
			if (location && "absentPath" in location) return location;
			throw error;
		}
	}
	const host = remoteHost(plan, hosts);
	if (!host) {
		throw new Error(
			`SSH host ${plan.hostId ?? "?"} not found for worktree removal`,
		);
	}
	const sshTarget = await prepareTrustedSshTarget(hosts, host.id);
	const helperPath = await prepareRemoteGitCheckoutHelper(sshTarget);
	const request = {
		schemaVersion: 1,
		operation: "capture",
		repo: plan.repo,
		worktreePath: plan.wtPath,
	} as const;
	try {
		const instance = parseRemoteGitCheckoutCapture(
			await sshExecOnce(
				sshTarget,
				remoteGitCheckoutCaptureExecution(helperPath, request),
			),
		);
		return { transport: "ssh", plan, instance, helperPath, sshTarget };
	} catch (error) {
		const paths = [plan.wtPath];
		const [location] = parseRemoteGitCheckoutLocations(
			paths,
			await sshExecOnce(
				sshTarget,
				remoteGitCheckoutLocationsExecution(helperPath, paths),
			),
		);
		if (location && "absentPath" in location) return location;
		throw error;
	}
}

type LocationCandidate<TAgent extends WorktreeAgent> =
	| { readonly kind: "inspect"; readonly agent: TAgent }
	| { readonly kind: "skip" }
	| { readonly kind: "unresolved"; readonly agent: TAgent };

function classifyLocationCandidate<TAgent extends WorktreeAgent>(
	removal: PreparedAgentWorktreeRemoval,
	agent: TAgent,
	projects: readonly WorktreeProject[],
): LocationCandidate<TAgent> {
	const transport = sessionKindExecutionProfile(agent.sessionKind).transport;
	const project = projects.find(
		(candidate) => candidate.id === agent.projectId,
	);
	if (!project) {
		if (transport !== removal.transport) return { kind: "skip" };
		return removal.transport === "local"
			? { kind: "inspect", agent }
			: { kind: "unresolved", agent };
	}
	if (removal.transport === "local") {
		return project.kind === "local"
			? { kind: "inspect", agent }
			: { kind: "skip" };
	}
	if (project.kind === "local") return { kind: "skip" };
	if (!project.sshHostId) return { kind: "unresolved", agent };
	return project.sshHostId === removal.plan.hostId
		? { kind: "inspect", agent }
		: { kind: "skip" };
}

function sameCheckoutLocation(
	left: GitCheckoutLocationV1,
	right: GitCheckoutInstanceV1,
): boolean {
	return (
		left.canonicalPath === right.canonicalPath &&
		left.gitCommonDir === right.gitCommonDir
	);
}

/** Only inputs to the Host lookup can invalidate its observed checkout users. */
export function sameAgentWorktreeScopeCandidates(
	removal: PreparedAgentWorktreeRemoval,
	before: {
		agents: readonly WorktreeAgent[];
		projects: readonly WorktreeProject[];
	},
	after: {
		agents: readonly WorktreeAgent[];
		projects: readonly WorktreeProject[];
	},
): boolean {
	const candidates = (state: typeof before) =>
		new Map(
			state.agents.flatMap((agent) => {
				const candidate = classifyLocationCandidate(
					removal,
					agent,
					state.projects,
				);
				return candidate.kind === "skip"
					? []
					: [
							[
								agent.id,
								{ kind: candidate.kind, path: agent.worktreePath },
							] as const,
						];
			}),
		);
	const expected = candidates(before);
	const current = candidates(after);
	return (
		expected.size === current.size &&
		[...expected].every(([id, candidate]) => {
			const match = current.get(id);
			return match?.kind === candidate.kind && match.path === candidate.path;
		})
	);
}

/**
 * Resolves every possibly colocated Agent through the same Host that owns the
 * deletion. Raw path spelling is never destructive authority.
 */
export async function inspectPreparedAgentWorktreeScope<
	TAgent extends WorktreeAgent,
>(
	removal: PreparedAgentWorktreeRemoval,
	agents: readonly TAgent[],
	projects: readonly WorktreeProject[],
): Promise<WorktreeRemovalScope<TAgent>> {
	const classified = agents.map((agent) =>
		classifyLocationCandidate(removal, agent, projects),
	);
	const candidates = classified.flatMap((candidate) =>
		candidate.kind === "inspect" ? [candidate.agent] : [],
	);
	const unresolvedAgents = classified.flatMap((candidate) =>
		candidate.kind === "unresolved" ? [candidate.agent] : [],
	);
	if (candidates.length === 0) {
		return { affectedAgents: [], unresolvedAgents };
	}
	const paths = [
		...new Set(candidates.map((candidate) => candidate.worktreePath)),
	];
	const locations =
		removal.transport === "local"
			? await locateGitCheckoutPaths(paths)
			: parseRemoteGitCheckoutLocations(
					paths,
					await sshExecOnce(
						removal.sshTarget,
						remoteGitCheckoutLocationsExecution(removal.helperPath, paths),
					),
				);
	const locationsByPath = new Map(
		paths.map((path, index) => [path, locations[index]] as const),
	);
	const affectedAgents: TAgent[] = [];
	const absentAgents: TAgent[] = [];
	for (const candidate of candidates) {
		const location = locationsByPath.get(candidate.worktreePath);
		if (!location) {
			unresolvedAgents.push(candidate);
		} else if ("absentPath" in location) {
			absentAgents.push(candidate);
		} else if (sameCheckoutLocation(location, removal.instance)) {
			affectedAgents.push(candidate);
		}
	}
	return { affectedAgents, unresolvedAgents, absentAgents };
}

export async function removePreparedAgentWorktree(
	removal: PreparedAgentWorktreeRemoval,
): Promise<GitCheckoutRemovalReceiptV1> {
	let receipt: GitCheckoutRemovalReceiptV1;
	if (removal.transport === "local") {
		receipt = await removeGitCheckoutInstance(
			removal.plan.repo,
			removal.instance,
			CONFIRMED_AGENT_WORKTREE_REMOVAL_POLICY,
		);
	} else {
		const request: GitCheckoutRemoveCommandV1 = {
			schemaVersion: 1,
			operation: "remove",
			repo: removal.plan.repo,
			instance: removal.instance,
			policy: CONFIRMED_AGENT_WORKTREE_REMOVAL_POLICY,
		};
		receipt = parseRemoteGitCheckoutRemoval(
			request,
			await sshExecOnce(
				removal.sshTarget,
				remoteGitCheckoutRemovalExecution(removal.helperPath, request),
			),
		);
	}
	return receipt;
}
