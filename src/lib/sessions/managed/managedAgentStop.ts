import { requireLegacyAgentWriterTarget } from "@/lib/agents/agentWriterPartition";
import { inspectHmuxSessionExact } from "@/lib/hmux/identity/exactHmuxSessionInspection";
import { resolveAgentByName } from "@/lib/hmux/identity/hmuxAgentTarget";
import { isHmuxManagedGenerationV1 } from "@/lib/hmux/identity/hmuxManagedGeneration";
import { isManagedStopReceiptV2 } from "@/lib/hmux/managed/managedRehostTargetReceipt";
import type { RemoteHmuxCatalogTargetV1 } from "@/lib/hmux/remote/remoteHmuxBroker";
import {
	type HmuxManagedStopFenceV1,
	hmux,
	prepareTrustedSshTarget,
	reconcileManagedCreateChainStop,
	remoteHmuxCatalog,
	remoteHmuxManagedCreateChainStop,
	remoteHmuxManagedStop,
} from "@/lib/ipc";
import { fnv1a64Hex } from "@/lib/platform/hash";
import {
	type ManagedAgentStopReceipt,
	type ManagedAgentStopTarget,
	remoteStopAuthorityIdentity,
} from "@/lib/sessions/managed/managedAgentStopSync";
import { requireAnyManagedAgentBinding } from "@/lib/sessions/managed/managedAgentTarget";
import type { TrustedSshTargetV1 } from "@/lib/ssh/trustedSshTarget";
import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import { useStore } from "@/store";
import type { Agent } from "@/types";

export type { ManagedAgentStopTarget } from "@/lib/sessions/managed/managedAgentStopSync";
export {
	applyManagedAgentChainStoppedSync,
	applyManagedAgentStoppedSync,
	finalizeManagedAgentRemoval,
	LEGACY_MANAGED_AGENT_CHAIN_STOPPED_EVENT,
	MANAGED_AGENT_CHAIN_STOPPED_EVENT,
	MANAGED_AGENT_STOPPED_EVENT,
	managedAgentStopReceiptAppliesToAgent,
} from "@/lib/sessions/managed/managedAgentStopSync";

/** Host 카탈로그가 sessionId 자체를 모른다는 확정적 부재 관측. 생성 전에
 *  죽은 스폰의 등록 잔해가 여기 해당한다 — stop할 대상이 존재하지 않으므로
 *  호출자는 등록 정리를 계속 진행할 수 있다. 같은 id가 다른 workspace나
 *  다른 class로 살아 있는 모호한 경우는 이 오류가 아니라 fail-closed다. */
export class ManagedSessionAbsentError extends Error {
	constructor(
		readonly sessionId: string,
		readonly workspaceId: string,
	) {
		super(
			`managed Hmux session ${sessionId} is absent from its host catalog (workspace ${workspaceId})`,
		);
		this.name = "ManagedSessionAbsentError";
	}
}

function isManagedCreateChainAlreadyAbsent(error: unknown): boolean {
	const message =
		error instanceof Error
			? error.message
			: typeof error === "string"
				? error
				: "";
	const code = message
		.replace(/^session_checkout_failed:\s*/, "")
		.split(":", 1)[0]
		.trim();
	return (
		code === "hmux_managed_create_chain_stop_not_found" ||
		code === "hmux_remote_managed_create_chain_stop_not_found"
	);
}

export interface ManagedAgentStopExecution {
	readonly target: ManagedAgentStopTarget;
	readonly receipt: ManagedAgentStopReceipt;
}

/** Durable stop completion does not depend on an optional pane remaining open. */
export async function reconcileManagedAgentStop(
	target: ManagedAgentStopTarget,
): Promise<ManagedAgentStopExecution | undefined> {
	if (
		target.binding.source !== "local" &&
		target.binding.createIdempotencyKey === undefined
	)
		return undefined;
	try {
		const operation = await prepareManagedAgentStopOperation(target);
		return operation.kind === "completed"
			? { target: operation.target, receipt: operation.receipt }
			: undefined;
	} catch (error) {
		if (error instanceof ManagedSessionAbsentError) return undefined;
		throw error;
	}
}

const inFlight = new Map<string, Promise<ManagedAgentStopReceipt>>();

/** Resolve one registered SSH host into its trusted remote catalog target. */
async function planTrustedRemoteCatalogTarget(hostId: string) {
	try {
		return await prepareTrustedSshTarget(useStore.getState().sshHosts, hostId);
	} catch (error) {
		if (
			error instanceof Error &&
			error.message === "trusted_ssh_host_not_registered"
		) {
			throw new PaneCommandError(
				"invalid_request",
				"remote managed SSH host is no longer registered",
			);
		}
		throw error;
	}
}

async function resolveManagedStopFence(
	target: ManagedAgentStopTarget,
	remoteTarget?: RemoteHmuxCatalogTargetV1,
): Promise<HmuxManagedStopFenceV1> {
	const { binding } = target;
	if (binding.source !== "local" && binding.stopFence) {
		return binding.stopFence;
	}
	if (binding.source === "local") {
		const session = await inspectHmuxSessionExact({
			sessionId: binding.sessionId,
			workspaceId: binding.workspaceId,
		});
		const catalogFence = session?.stopFence;
		if (
			catalogFence &&
			isHmuxManagedGenerationV1(catalogFence) &&
			catalogFence.terminalEpoch === session?.terminalEpoch
		) {
			// The stable session/workspace identity names the resource the user
			// selected. Its process generation may legitimately advance while an
			// older app projection remains open, so resolve the current exact fence
			// immediately before stop. The runtime rechecks the same fence at the
			// destructive boundary and still refuses a later replacement race.
			return catalogFence;
		}
		if (!session) {
			throw new ManagedSessionAbsentError(
				binding.sessionId,
				binding.workspaceId,
			);
		}
	} else {
		if (!remoteTarget) {
			throw new PaneCommandError(
				"invalid_request",
				"remote managed stop target was not prepared",
			);
		}
		const catalogSessions = (await remoteHmuxCatalog(remoteTarget)).sessions;
		const session = catalogSessions.find(
			(candidate) =>
				candidate.sessionId === binding.sessionId &&
				candidate.workspaceId === binding.workspaceId &&
				candidate.sessionClass === "managed",
		);
		if (session) {
			return {
				runnerPrincipal: session.runnerPrincipal,
				runnerInstance: session.runnerInstance,
				channelEpoch: session.channelEpoch,
				hostInstanceId: session.hostInstanceId,
				terminalEpoch: session.terminalEpoch,
			};
		}
		if (
			!catalogSessions.some(
				(candidate) => candidate.sessionId === binding.sessionId,
			)
		) {
			throw new ManagedSessionAbsentError(
				binding.sessionId,
				binding.workspaceId,
			);
		}
	}
	throw new PaneCommandError(
		"pane_changed",
		"managed Hmux stop could not resolve the exact current generation",
	);
}

export function resolveManagedAgentStopTarget(
	target: string | Agent,
): ManagedAgentStopTarget {
	const agent = requireLegacyAgentWriterTarget(
		typeof target === "string" ? resolveAgentByName(target) : target,
	);
	return {
		agent,
		binding: requireAnyManagedAgentBinding(agent),
	};
}

/** Freezes the remote endpoint and trust pins before a multi-step lifecycle starts. */
export async function prepareManagedAgentStopTarget(
	target: ManagedAgentStopTarget,
	remoteTarget?: TrustedSshTargetV1,
): Promise<ManagedAgentStopTarget> {
	if (target.binding.source === "local") return target;
	if (remoteTarget) {
		if (remoteTarget.hostId !== target.binding.hostId) {
			throw new PaneCommandError(
				"pane_changed",
				"managed Agent and remote lifecycle target use different hosts",
			);
		}
		return { ...target, remoteTarget };
	}
	return {
		...target,
		remoteTarget: await planTrustedRemoteCatalogTarget(target.binding.hostId),
	};
}

export type PreparedManagedAgentStopOperation =
	| {
			readonly kind: "completed";
			readonly target: ManagedAgentStopTarget;
			readonly receipt: ManagedAgentStopReceipt;
	  }
	| {
			readonly kind: "chain";
			readonly target: ManagedAgentStopTarget;
			readonly idempotencyKey: string;
			readonly authorityKey: string;
	  }
	| {
			readonly kind: "exact";
			readonly target: ManagedAgentStopTarget;
			readonly stopFence: HmuxManagedStopFenceV1;
			readonly stopId: string;
			readonly authorityKey: string;
	  };

export async function prepareManagedAgentStopOperation(
	target: Agent | ManagedAgentStopTarget,
): Promise<PreparedManagedAgentStopOperation> {
	const resolved: ManagedAgentStopTarget =
		"binding" in target ? target : resolveManagedAgentStopTarget(target);
	const prepared =
		resolved.binding.source === "ssh" && !resolved.remoteTarget
			? await prepareManagedAgentStopTarget(resolved)
			: resolved;
	const { binding } = prepared;
	const remoteAuthority = prepared.remoteTarget
		? remoteStopAuthorityIdentity(prepared.remoteTarget)
		: "local";
	if (binding.createIdempotencyKey !== undefined) {
		const idempotencyKey = binding.createIdempotencyKey;
		const receipt = await reconcileManagedCreateChainStop({
			idempotencyKey,
			sessionId: binding.sessionId,
			workspaceId: binding.workspaceId,
			...(prepared.remoteTarget ? { target: prepared.remoteTarget } : {}),
		});
		if (receipt) return { kind: "completed", target: prepared, receipt };
		return {
			kind: "chain",
			target: prepared,
			idempotencyKey,
			authorityKey: [
				"create-chain",
				binding.source,
				binding.hostId,
				binding.workspaceId,
				binding.sessionId,
				idempotencyKey,
				remoteAuthority,
			].join("\0"),
		};
	}
	const retirement =
		binding.source === "local"
			? await hmux.readManagedSessionRetirement(
					binding.sessionId,
					binding.workspaceId,
				)
			: undefined;
	if (retirement?.kind === "finalized") {
		return { kind: "completed", target: prepared, receipt: retirement.receipt };
	}
	let absent: ManagedSessionAbsentError | undefined;
	let stopFence: HmuxManagedStopFenceV1;
	try {
		stopFence = await resolveManagedStopFence(prepared, prepared.remoteTarget);
	} catch (error) {
		if (
			!(error instanceof ManagedSessionAbsentError) ||
			retirement?.kind !== "no_ledger" ||
			!binding.stopFence
		)
			throw error;
		// A historical fence can select completed evidence after discovery loss,
		// but never a new stop. Preserve absence if no such receipt exists.
		absent = error;
		stopFence = binding.stopFence;
	}
	const operation = exactManagedAgentStopOperation(prepared, stopFence);
	if (retirement?.kind === "no_ledger") {
		const receipt = await hmux.readCompletedManagedStop(
			operation.stopId,
			binding.sessionId,
			binding.workspaceId,
			operation.stopFence,
		);
		if (receipt !== null) {
			validateExactStopReceipt(operation, receipt);
			return { kind: "completed", target: prepared, receipt };
		}
	}
	if (absent) throw absent;
	return operation;
}

function exactManagedAgentStopOperation(
	target: ManagedAgentStopTarget,
	stopFence: HmuxManagedStopFenceV1,
): Extract<PreparedManagedAgentStopOperation, { kind: "exact" }> {
	const remoteAuthority = target.remoteTarget
		? remoteStopAuthorityIdentity(target.remoteTarget)
		: "local";
	const authorityKey = [
		"exact-generation",
		target.binding.hostId,
		target.binding.workspaceId,
		target.binding.sessionId,
		stopFence.runnerPrincipal,
		stopFence.runnerInstance,
		stopFence.channelEpoch,
		stopFence.hostInstanceId,
		stopFence.terminalEpoch,
		remoteAuthority,
	].join("\0");
	return {
		kind: "exact",
		target,
		stopFence,
		stopId: `stop_${fnv1a64Hex(authorityKey)}`,
		authorityKey,
	};
}

function validateExactStopReceipt(
	operation: Extract<PreparedManagedAgentStopOperation, { kind: "exact" }>,
	receipt: ManagedAgentStopReceipt,
): void {
	const { binding } = operation.target;
	if (
		!isManagedStopReceiptV2(receipt, {
			stopId: operation.stopId,
			sessionId: binding.sessionId,
			workspaceId: binding.workspaceId,
			...operation.stopFence,
		})
	) {
		throw new PaneCommandError(
			"pane_changed",
			"managed Hmux stop receipt does not match the requested agent identity",
		);
	}
}

export function stopPreparedManagedAgentProvider(
	operation: PreparedManagedAgentStopOperation,
): Promise<ManagedAgentStopReceipt> {
	if (operation.kind === "completed") return Promise.resolve(operation.receipt);
	const { target, authorityKey } = operation;
	const current = useStore
		.getState()
		.agents.find((agent) => agent.id === target.agent.id);
	if (current) requireLegacyAgentWriterTarget(current);
	const { binding, remoteTarget } = target;
	const existing = inFlight.get(authorityKey);
	if (existing) return existing;
	const stop = async (): Promise<ManagedAgentStopReceipt> => {
		if (operation.kind === "chain") {
			if (binding.source === "local") {
				return hmux.stopManagedCreateChain(
					operation.idempotencyKey,
					binding.sessionId,
					binding.workspaceId,
				);
			}
			if (!remoteTarget) {
				throw new PaneCommandError(
					"invalid_request",
					"remote managed stop target was not prepared",
				);
			}
			return remoteHmuxManagedCreateChainStop({
				target: remoteTarget,
				idempotencyKey: operation.idempotencyKey,
				sessionId: binding.sessionId,
				workspaceId: binding.workspaceId,
			});
		}
		if (binding.source === "local") {
			return hmux.stopManaged(
				operation.stopId,
				binding.sessionId,
				binding.workspaceId,
				operation.stopFence,
			);
		}
		if (!remoteTarget) {
			throw new PaneCommandError(
				"invalid_request",
				"remote managed stop target was not prepared",
			);
		}
		return remoteHmuxManagedStop({
			target: remoteTarget,
			stopId: operation.stopId,
			sessionId: binding.sessionId,
			workspaceId: binding.workspaceId,
			expectedFence: operation.stopFence,
		});
	};
	const request = stop()
		.catch((error) => {
			if (
				operation.kind === "chain" &&
				isManagedCreateChainAlreadyAbsent(error)
			) {
				throw new ManagedSessionAbsentError(
					binding.sessionId,
					binding.workspaceId,
				);
			}
			throw error;
		})
		.then((receipt) => {
			if (operation.kind === "chain") return receipt;
			validateExactStopReceipt(operation, receipt);
			return receipt;
		})
		.finally(() => {
			if (inFlight.get(authorityKey) === request) inFlight.delete(authorityKey);
		});
	inFlight.set(authorityKey, request);
	return request;
}

export async function stopManagedAgentProvider(
	target: Agent | ManagedAgentStopTarget,
): Promise<ManagedAgentStopExecution> {
	const operation = await prepareManagedAgentStopOperation(target);
	return {
		target: operation.target,
		receipt: await stopPreparedManagedAgentProvider(operation),
	};
}
