import {
	observeManagedRebootRecovery,
	publishRebootRecoveryPaneState,
	type RebootRecoveryProgress,
	recoverRebootStaleManagedAgent,
} from "@/lib/sessions/managed/automaticManagedRehostService";
import { runExclusiveOfAutomaticManagedRehost } from "@/lib/sessions/managed/automaticManagedRehostRuntime";
import { managedAgentWorktreeRecovery } from "@/lib/sessions/managed/managedAgentWorktreeRecovery";
import type { AutomaticManagedRebootRecoveryCandidate } from "@/lib/sessions/managed/managedRebootRecovery";
import {
	agentEntry,
	beginRestoreAll,
	finishRestoreAll,
	type RestoreAllAgentEntry,
	type RestoreAllReport,
	type RestoreAllSkippedEntry,
	reportRestoreAllProgress,
} from "@/lib/sessions/managed/managedRestoreAllOffer";
import type { TerminalAttachWorktreeStatus } from "@/lib/terminal/terminalAttachRecovery";
import { useStore } from "@/store";

export interface RestoreAllDependencies {
	observe: typeof observeManagedRebootRecovery;
	recover: (
		candidate: AutomaticManagedRebootRecoveryCandidate,
		progress: RebootRecoveryProgress,
	) => Promise<boolean>;
	/** Advisory: a missing checkout is reported, never recreated here. */
	inspectWorktree: (
		agentId: string,
	) => Promise<TerminalAttachWorktreeStatus | undefined>;
	publishPaneState: typeof publishRebootRecoveryPaneState;
	exclusive: typeof runExclusiveOfAutomaticManagedRehost;
}

const defaultDependencies: RestoreAllDependencies = {
	observe: observeManagedRebootRecovery,
	recover: (candidate, progress) =>
		recoverRebootStaleManagedAgent(candidate, "all", progress),
	inspectWorktree: async (agentId) => {
		const state = useStore.getState();
		const agent = state.agents.find((candidate) => candidate.id === agentId);
		const project = state.projects.find(
			(candidate) => candidate.id === agent?.projectId,
		);
		return agent
			? managedAgentWorktreeRecovery(agent, project)?.inspect()
			: undefined;
	},
	publishPaneState: publishRebootRecoveryPaneState,
	exclusive: runExclusiveOfAutomaticManagedRehost,
};

async function restoreAll(
	dependencies: RestoreAllDependencies,
): Promise<RestoreAllReport> {
	const assessments = await dependencies.observe();
	if (!assessments) {
		return { restored: [], skipped: [], failed: [], unavailable: true };
	}
	const agents = () => useStore.getState().agents;
	const restored: RestoreAllAgentEntry[] = [];
	const failed: RestoreAllAgentEntry[] = [];
	const skipped: RestoreAllSkippedEntry[] = assessments.flatMap((assessment) =>
		assessment.outcome === "skipped"
			? [
					{
						...agentEntry(agents(), assessment.identity, assessment.agentId),
						reason: assessment.reason,
					},
				]
			: [],
	);
	const candidates = assessments
		.flatMap((assessment) =>
			assessment.outcome === "restorable" ? [assessment.candidate] : [],
		)
		.sort((left, right) => left.identity.localeCompare(right.identity));
	reportRestoreAllProgress(0, candidates.length);
	for (const candidate of candidates) {
		dependencies.publishPaneState(candidate, "recovering", "restore_all");
	}
	// One at a time, like the unattended pass: each restore prepares its own
	// background Space and runs one backend transaction.
	for (const [index, candidate] of candidates.entries()) {
		const entry = () =>
			agentEntry(agents(), candidate.identity, candidate.agentId);
		const progress: RebootRecoveryProgress = {};
		try {
			if (
				(await dependencies.inspectWorktree(candidate.agentId)) === "missing"
			) {
				dependencies.publishPaneState(candidate, "error", "worktree_missing");
				skipped.push({ ...entry(), reason: "worktree_missing" });
			} else if (await dependencies.recover(candidate, progress)) {
				restored.push(entry());
			} else {
				skipped.push({ ...entry(), reason: "state_changed" });
			}
		} catch (error) {
			if (!progress.replacement) {
				dependencies.publishPaneState(candidate, "error", "restore_all_failed");
			}
			failed.push(entry());
			console.warn("[restore all agents]", {
				error,
				agentId: candidate.agentId,
				identity: candidate.identity,
				replacementSessionId: progress.replacement?.sessionId,
			});
		}
		reportRestoreAllProgress(index + 1, candidates.length);
	}
	return { restored, skipped, failed };
}

/** Restore every local Agent whose Host is gone, in every Space, into its own
 * pane, conversation, worktree and account. Runs while no unattended pass
 * runs; agents that cannot be restored are reported with a reason. */
export async function restoreAllManagedAgents(
	dependencies: RestoreAllDependencies = defaultDependencies,
): Promise<void> {
	if (!beginRestoreAll()) return;
	let report: RestoreAllReport;
	try {
		report = await dependencies.exclusive(() => restoreAll(dependencies));
	} catch (error) {
		console.warn("[restore all agents]", { error });
		report = { restored: [], skipped: [], failed: [], unavailable: true };
	}
	finishRestoreAll(report);
}
