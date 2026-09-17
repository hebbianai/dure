import { hmuxSessionMetadataKey } from "@/lib/hmux/identity/hmuxSessionMetadata";
import type { SessionRuntimeStoreSlice } from "@/lib/sessions/runtime/sessionRuntimeStoreSlice";
import type { Agent, AgentRuntimeBindingV1, SshState } from "@/types";

type ManagedBinding = Extract<
	AgentRuntimeBindingV1,
	{ runtime: "hmux_managed_v1" }
>;

type ProjectionState = Pick<
	SessionRuntimeStoreSlice,
	| "sessionAgentRuntimeState"
	| "sessionAgentRuntimeObservers"
	| "hmuxSessionMetadata"
	| "sessionCwd"
	| "sessionAgent"
	| "sessionTitle"
	| "sessionActivity"
	| "sessionAgentPin"
> & {
	agents: Agent[];
	sshStates: Record<string, SshState>;
	sshMessages: Record<string, string>;
};

function withoutRecordKey<T>(record: Record<string, T>, key: string) {
	if (!(key in record)) return record;
	const next = { ...record };
	delete next[key];
	return next;
}

/**
 * Atomically installs Hmux's ledger-owned create successor. Source-generation
 * projections are discarded; only cwd is established for the successor until
 * fresh Host observations arrive.
 */
export function managedCreateSuccessorProjection(
	state: ProjectionState,
	current: Agent,
	targetBinding: ManagedBinding,
) {
	const projected: Agent = {
		...current,
		sessionId: targetBinding.sessionId,
		started: true,
		pendingCmd: undefined,
		runtimeBinding: targetBinding,
	};
	const agents = state.agents.map((candidate) =>
		candidate.id === current.id ? projected : candidate,
	);
	if (current.sessionId === targetBinding.sessionId) return { agents };

	// This map also receives the successor cwd, so it must always be detached
	// from the Zustand snapshot even when the source never had a cwd entry.
	const sessionCwd = { ...state.sessionCwd };
	delete sessionCwd[current.sessionId];
	sessionCwd[targetBinding.sessionId] = current.worktreePath;
	return {
		agents,
		sessionAgentRuntimeObservers: withoutRecordKey(
			state.sessionAgentRuntimeObservers,
			current.sessionId,
		),
		sessionAgentRuntimeState: withoutRecordKey(
			state.sessionAgentRuntimeState,
			current.sessionId,
		),
		hmuxSessionMetadata: withoutRecordKey(
			state.hmuxSessionMetadata,
			hmuxSessionMetadataKey(targetBinding.workspaceId, current.sessionId),
		),
		sessionCwd,
		sessionAgent: withoutRecordKey(state.sessionAgent, current.sessionId),
		sessionTitle: withoutRecordKey(state.sessionTitle, current.sessionId),
		sessionActivity: withoutRecordKey(state.sessionActivity, current.sessionId),
		sessionAgentPin: withoutRecordKey(state.sessionAgentPin, current.sessionId),
		sshStates: withoutRecordKey(state.sshStates, current.sessionId),
		sshMessages: withoutRecordKey(state.sshMessages, current.sessionId),
	};
}
