// Shared agent-removal record cleanup — extracted from store.ts so the
// consuming composition slices (ssh hosts, projects, agent registry) can share
// one authority for which per-agent/per-session records a removal clears.
import { omitRecordKeys } from "@/lib/persistence/storeCollections";
import type { ScmReviewStoreSlice } from "@/lib/scm/review/scmReviewStoreSlice";
import type { SessionRuntimeStoreSlice } from "@/lib/sessions/runtime/sessionRuntimeStoreSlice";
import type { SshState } from "@/types";

/** The exact record keys every agent-removal cascade clears; consuming slices
 *  compose this into their cross-slice HostState so the host store must carry
 *  all of them alongside the slice. */
export type RemovedAgentRecordsHost = Pick<
	SessionRuntimeStoreSlice,
	| "agentActivity"
	| "agentRuntimeLaunchPresentation"
	| "restartRequests"
	| "sessionAgentRuntimeState"
	| "sessionAgentRuntimeObservers"
	| "sessionCwd"
	| "sessionAgent"
	| "sessionTitle"
	| "sessionActivity"
	| "sessionAgentPin"
> &
	Pick<
		ScmReviewStoreSlice,
		"diffComments" | "gitStatuses" | "gitStatusErrors"
	> & {
		sshStates: Record<string, SshState>;
		sshMessages: Record<string, string>;
	};

/**
 * Shared cleanup for every agent-removal path (removeProject / removeSshHost /
 * removeAgent): drops the per-agent and per-session runtime records of the
 * removed agents. Callers keep their own leading list filters
 * (projects/agents/sshHosts/detected) and spread this into the state patch.
 */
export function omitRemovedAgentRecords(
	s: RemovedAgentRecordsHost,
	agentIds: ReadonlySet<string>,
	sessionIds: ReadonlySet<string>,
) {
	return {
		agentActivity: omitRecordKeys(s.agentActivity, agentIds),
		agentRuntimeLaunchPresentation: omitRecordKeys(
			s.agentRuntimeLaunchPresentation,
			agentIds,
		),
		diffComments: omitRecordKeys(s.diffComments, agentIds),
		gitStatuses: omitRecordKeys(s.gitStatuses, agentIds),
		gitStatusErrors: omitRecordKeys(s.gitStatusErrors, agentIds),
		restartRequests: omitRecordKeys(s.restartRequests, agentIds),
		sessionAgentRuntimeState: omitRecordKeys(
			s.sessionAgentRuntimeState,
			sessionIds,
		),
		sessionAgentRuntimeObservers: omitRecordKeys(
			s.sessionAgentRuntimeObservers,
			sessionIds,
		),
		sessionCwd: omitRecordKeys(s.sessionCwd, sessionIds),
		sessionAgent: omitRecordKeys(s.sessionAgent, sessionIds),
		sessionTitle: omitRecordKeys(s.sessionTitle, sessionIds),
		sessionActivity: omitRecordKeys(s.sessionActivity, sessionIds),
		sessionAgentPin: omitRecordKeys(s.sessionAgentPin, sessionIds),
		sshStates: omitRecordKeys(s.sshStates, sessionIds),
		sshMessages: omitRecordKeys(s.sshMessages, sessionIds),
	};
}
