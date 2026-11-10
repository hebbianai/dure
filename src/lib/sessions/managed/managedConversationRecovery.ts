import { agentRuntimePaneActionOwnerKey } from "@/lib/agents/agentRuntimePaneAction";
import type { ManagedCreateDiagnostics } from "@/lib/hmux/managed/managedRefreshTiming";
import {
	isClosedManagedSourceLineage,
	wakeClosedManagedLineage,
} from "@/lib/sessions/managed/managedClosedLineageWake";
import { resumeExactManagedAgentPane } from "@/lib/sessions/managed/managedExactConversationResume";
import { recordManagedRecoveryFailure } from "@/lib/sessions/managed/managedRecoveryDiagnostics";
import { useStore } from "@/store";

type RecoveryReceipt =
	| Awaited<ReturnType<typeof resumeExactManagedAgentPane>>
	| Exclude<Awaited<ReturnType<typeof wakeClosedManagedLineage>>, undefined>;

const inFlight = new Map<string, Promise<RecoveryReceipt>>();

/** Resume, Refresh and registered pane actions share this recovery policy.
 * Only a confirmed closed checkout permits a different launch mechanism;
 * transport failures keep their original uncertain outcome. A failure leaves
 * one durable diagnostic naming the step that failed and its code. */
export async function recoverManagedConversationPane(
	agentId: string,
	panelId: string,
	conversationId: string,
	diagnostics?: ManagedCreateDiagnostics,
): Promise<RecoveryReceipt> {
	const agent = useStore
		.getState()
		.agents.find((candidate) => candidate.id === agentId);
	const key = JSON.stringify([
		agentId,
		agent && agentRuntimePaneActionOwnerKey(agent),
		conversationId.trim(),
		agent?.worktreePath,
		agent?.credentialId,
		agent?.runtimeBinding?.runtime === "hmux_managed_v1"
			? agent.runtimeBinding.credentialId
			: undefined,
		agent?.pendingCredentialSwitch,
	]);
	const existing = inFlight.get(key);
	if (existing) {
		diagnostics?.timing?.mark("resume.join");
		return existing;
	}
	const recovery = (async () => {
		try {
			return await resumeExactManagedAgentPane(
				agentId,
				panelId,
				conversationId,
				diagnostics,
			);
		} catch (cause) {
			if (!isClosedManagedSourceLineage(cause)) {
				recordManagedRecoveryFailure("exact_resume", agentId, cause);
				throw cause;
			}
			let woken: Awaited<ReturnType<typeof wakeClosedManagedLineage>>;
			try {
				woken = await wakeClosedManagedLineage(agentId, conversationId);
			} catch (wakeFailure) {
				recordManagedRecoveryFailure("lineage_wake", agentId, wakeFailure);
				throw wakeFailure;
			}
			if (!woken) {
				recordManagedRecoveryFailure("exact_resume", agentId, cause);
				throw cause;
			}
			return woken;
		}
	})();
	inFlight.set(key, recovery);
	try {
		return await recovery;
	} finally {
		if (inFlight.get(key) === recovery) inFlight.delete(key);
	}
}
