import {
	ensureRemoteManagedAgentRuntime,
	type RemoteManagedAgentEnsureReceipt,
} from "@/lib/sessions/launch/remoteManagedAgentRuntime";
import {
	ensureManagedAgentRuntime,
	type ManagedAgentEnsureReceipt,
} from "@/lib/sessions/managed/managedAgentRuntime";
import type { Agent } from "@/types";

interface ManagedRuntimeEnsureReceipt {
	readonly agent: Agent;
	readonly sessionId: string;
	readonly workspaceId: string;
	readonly idempotencyKey: string;
	readonly initialPromptAccepted?: boolean;
	/** Only a Host-returned cwd is authoritative at an exact worktree boundary. */
	readonly confirmedCwd?: string;
}

export interface ManagedRuntimeEnsureOperation {
	readonly source: "local" | "ssh";
	readonly receipt: Promise<ManagedRuntimeEnsureReceipt>;
}

function localReceipt(
	receipt: ManagedAgentEnsureReceipt,
): ManagedRuntimeEnsureReceipt {
	return {
		agent: receipt.agent,
		sessionId: receipt.session.sessionId,
		workspaceId: receipt.session.workspaceId,
		idempotencyKey: receipt.idempotencyKey,
		...(receipt.initialPromptAccepted === true
			? { initialPromptAccepted: true }
			: {}),
		...(receipt.cwd === undefined ? {} : { confirmedCwd: receipt.cwd }),
	};
}

function remoteReceipt(
	receipt: RemoteManagedAgentEnsureReceipt,
): ManagedRuntimeEnsureReceipt {
	return {
		agent: receipt.agent,
		sessionId: receipt.sessionId,
		workspaceId: receipt.workspaceId,
		idempotencyKey: receipt.idempotencyKey,
		...(receipt.initialPromptAccepted === true
			? { initialPromptAccepted: true }
			: {}),
	};
}

function unsupportedManagedRuntimeSource(source: never): never {
	throw new Error(`unsupported managed runtime source: ${String(source)}`);
}

/** Begins the source adapter selected by the Agent's managed binding. The
 * caller decides only whether its surface waits for the returned receipt. */
export function beginManagedRuntimeEnsure(
	agent: Agent,
	options: { columns: number; rows: number; initialPrompt?: string },
): ManagedRuntimeEnsureOperation | undefined {
	const binding = agent.runtimeBinding;
	if (binding?.runtime !== "hmux_managed_v1") return undefined;
	const { source } = binding;
	switch (source) {
		case "local":
			return {
				source: "local",
				receipt: ensureManagedAgentRuntime(agent, options).then(localReceipt),
			};
		case "ssh":
			return {
				source: "ssh",
				receipt: ensureRemoteManagedAgentRuntime(agent, options).then(
					remoteReceipt,
				),
			};
	}
	return unsupportedManagedRuntimeSource(source);
}
