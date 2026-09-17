/**
 * Shared builders for Agent records, hmux runtime bindings, and session
 * summaries used across test suites.
 *
 * Before this module, ~40 suites each hand-rolled these literals (26 local
 * `agent()` definitions, 163 inline `runtimeBinding:` blocks); a field
 * addition meant touching every copy. Suites keep their own IDs by passing a
 * patch, or wrap these in a one-line local default.
 */
import { hmuxSessionMetadataKey } from "@/lib/hmux/identity/hmuxSessionMetadata";
import type { HmuxSessionSummary } from "@/lib/ipc/hmuxContracts";
import type {
	Agent,
	AgentRuntimeBindingV1,
	HmuxManagedStopFenceV1,
} from "@/types";

type ManagedLocalBinding = Extract<
	AgentRuntimeBindingV1,
	{ runtime: "hmux_managed_v1"; source: "local" }
>;

export function stopFenceFixture(
	patch: Partial<HmuxManagedStopFenceV1> = {},
): HmuxManagedStopFenceV1 {
	return {
		runnerPrincipal: "principal-1",
		runnerInstance: "runner-1",
		channelEpoch: "7",
		hostInstanceId: "host-instance-1",
		terminalEpoch: "terminal-epoch-1",
		...patch,
	};
}

/** Local hmux managed runtime binding in the shape Agent records carry. */
export function managedBindingFixture(
	patch: Partial<ManagedLocalBinding> = {},
): ManagedLocalBinding {
	return {
		schemaVersion: 1,
		runtime: "hmux_managed_v1",
		source: "local",
		hostId: "local",
		sessionId: "session-1",
		workspaceId: "workspace-1",
		createIdempotencyKey: "create-1",
		...patch,
	};
}

/** Base legacy pty agent — no runtime binding. */
export function agentFixture(patch: Partial<Agent> = {}): Agent {
	return {
		id: "agent-1",
		name: "agent-1",
		provider: "codex",
		projectId: "project-1",
		worktreePath: "/repo/.worktrees/agent-1",
		branch: "agent-1",
		sessionId: "session-1",
		sessionKind: "pty",
		...patch,
	};
}

/** Started agent carrying a local hmux managed binding. */
export function managedAgentFixture(patch: Partial<Agent> = {}): Agent {
	return agentFixture({
		runtimeBinding: managedBindingFixture(),
		started: true,
		...patch,
	});
}

export function hmuxSessionSummaryFixture(
	patch: Partial<HmuxSessionSummary> = {},
): HmuxSessionSummary {
	return {
		sessionId: "session-1",
		sessionName: "session-1",
		workspaceId: "workspace-1",
		sessionClass: "managed",
		lifecycle: "ready",
		health: "current_healthy",
		terminalEpoch: "terminal-1",
		outputSeq: "0",
		capabilities: [],
		...patch,
	};
}

/** Keyed session-metadata map in the shape pane components consume. */
export function hmuxSessionMetadataFixture(
	patch: Partial<HmuxSessionSummary> = {},
): Record<string, HmuxSessionSummary> {
	const summary = hmuxSessionSummaryFixture(patch);
	return {
		[hmuxSessionMetadataKey(summary.workspaceId, summary.sessionId)]: summary,
	};
}
