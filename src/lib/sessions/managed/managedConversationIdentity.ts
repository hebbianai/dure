import {
	type ConversationIdentityReadiness,
	readinessFromEvidence,
} from "@/lib/sessions/managed/conversationIdentityReadiness";
import {
	type HmuxManagedGenerationV1,
	parseHmuxManagedGenerationV1,
	sameHmuxManagedGeneration,
} from "@/lib/hmux/identity/hmuxManagedGeneration";
import type {
	Agent,
	Provider,
	ProviderConversationIdentityBindingV1,
} from "@/types";
import { PROVIDERS } from "@/types";

export interface ManagedConversationIdentityEvidence {
	sessionId: string;
	workspaceId: string;
	providerId: Provider;
	conversationId: string;
}

export interface HookSessionFence extends HmuxManagedGenerationV1 {
	sessionId: string;
	workspaceId: string;
}

export type HookSessionFenceEvidence =
	| { kind: "legacy" }
	| { kind: "malformed" }
	| { kind: "fenced"; fence: HookSessionFence };

const SAFE_ID = /^[A-Za-z0-9._:+-]{1,256}$/;
const DECIMAL_U64 = /^(0|[1-9][0-9]*)$/;
const MAX_U64 = 18_446_744_073_709_551_615n;
const PROVIDER_IDS = new Set(Object.keys(PROVIDERS));

export type ProjectedConversationIdentity = Omit<
	ProviderConversationIdentityBindingV1,
	"schemaVersion"
>;

/** The Host projection carried by the managed binding is canonical. The
 * top-level value remains only as the durable pre-projection legacy source. */
export function managedConversationId(agent: Agent): string | undefined {
	const binding = agent.runtimeBinding;
	const projected =
		binding?.runtime === "hmux_managed_v1"
			? binding.conversationIdentity?.conversationId.trim()
			: undefined;
	return projected || agent.conversationId?.trim() || undefined;
}

export function conversationIdentityFromHook(
	value: Record<string, unknown>,
): string | undefined {
	const candidate = value.conversationId;
	if (typeof candidate !== "string") return undefined;
	const conversationId = candidate.trim();
	return SAFE_ID.test(conversationId)
		? conversationId
		: undefined;
}

/** Current Hosts send one complete generation fence. A present-but-invalid
 * field is never treated as legacy evidence because that would let a partial
 * current report silently downgrade to the unfenced path. */
export function hookSessionFenceEvidence(
	value: Record<string, unknown>,
): HookSessionFenceEvidence {
	if (!Object.keys(value).includes("sessionFence")) {
		return { kind: "legacy" };
	}
	const candidate = value.sessionFence;
	if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
		return { kind: "malformed" };
	}
	const fence = candidate as Record<string, unknown>;
	const actualKeys = Object.keys(fence);
	const expectedKeys = [
		"sessionId",
		"workspaceId",
		"runnerPrincipal",
		"runnerInstance",
		"channelEpoch",
		"hostInstanceId",
		"terminalEpoch",
	];
	const generation = parseHmuxManagedGenerationV1({
		runnerPrincipal: fence.runnerPrincipal,
		runnerInstance: fence.runnerInstance,
		channelEpoch: fence.channelEpoch,
		hostInstanceId: fence.hostInstanceId,
		terminalEpoch: fence.terminalEpoch,
	});
	if (
		actualKeys.length !== expectedKeys.length ||
		expectedKeys.some((key) => !actualKeys.includes(key)) ||
		typeof fence.sessionId !== "string" ||
		!SAFE_ID.test(fence.sessionId) ||
		typeof fence.workspaceId !== "string" ||
		!SAFE_ID.test(fence.workspaceId) ||
		!generation
	) {
		return { kind: "malformed" };
	}
	return {
		kind: "fenced",
		fence: {
			sessionId: fence.sessionId as string,
			workspaceId: fence.workspaceId as string,
			...generation,
		},
	};
}

/**
 * Commit only against the exact current runtime binding. Delayed hooks or live
 * inspection from a predecessor Host cannot overwrite a successor session.
 */
export function applyManagedConversationIdentity(
	agents: readonly Agent[],
	evidence: ManagedConversationIdentityEvidence,
): readonly Agent[] {
	if (!SAFE_ID.test(evidence.conversationId)) return agents;
	let changed = false;
	const next = agents.map((agent) => {
		const binding = agent.runtimeBinding;
		const currentConversationId = agent.conversationId?.trim();
		if (
			(currentConversationId !== undefined &&
				currentConversationId !== "" &&
				currentConversationId !== evidence.conversationId) ||
			agent.sessionId !== evidence.sessionId ||
			agent.provider !== evidence.providerId ||
			binding?.runtime !== "hmux_managed_v1" ||
			binding.sessionId !== evidence.sessionId ||
			binding.workspaceId !== evidence.workspaceId
		) {
			return agent;
		}
		if (
			currentConversationId === evidence.conversationId &&
			agent.conversationIdentity?.state === "ready" &&
			agent.conversationIdentity.conversationId === evidence.conversationId
		) {
			return agent;
		}
		changed = true;
		return {
			...agent,
			conversationId: evidence.conversationId,
			conversationIdentity: readinessFromEvidence(evidence.conversationId),
		};
	});
	return changed ? next : agents;
}

/**
 * 신원 관측 결과를 그 세션의 에이전트에 남긴다.
 *
 * 확정(ready)은 applyManagedConversationIdentity가 fence를 검사해 커밋하므로
 * 여기서는 다루지 않는다 — 이 함수는 "왜 아직/왜 못 하는가"만 기록한다.
 * 이미 conversationId가 있는 에이전트는 건드리지 않는다: 뒤늦게 도착한
 * pending 관측이 확정된 신원을 흐리면 안 된다.
 */
export function applyConversationIdentityReadiness(
	agents: readonly Agent[],
	sessionId: string,
	readiness: ConversationIdentityReadiness,
): readonly Agent[] {
	let changed = false;
	const next = agents.map((agent) => {
		if (agent.sessionId !== sessionId || agent.conversationId) return agent;
		if (
			agent.conversationIdentity?.state === readiness.state &&
			(agent.conversationIdentity as { code?: string }).code ===
				(readiness as { code?: string }).code
		) {
			return agent;
		}
		changed = true;
		return { ...agent, conversationIdentity: readiness };
	});
	return changed ? next : agents;
}

function exactProjectionFence(
	current: ProviderConversationIdentityBindingV1,
	next: ProjectedConversationIdentity,
): boolean {
	return (
		current.sessionId === next.sessionId &&
		current.workspaceId === next.workspaceId &&
		sameHmuxManagedGeneration(current, next)
	);
}

function stopFenceFromProjection(projection: ProjectedConversationIdentity) {
	return {
		runnerPrincipal: projection.runnerPrincipal,
		runnerInstance: projection.runnerInstance,
		channelEpoch: projection.channelEpoch,
		hostInstanceId: projection.hostInstanceId,
		terminalEpoch: projection.terminalEpoch,
	};
}

function projectionMatchesRemoteStopFence(
	binding: Extract<
		NonNullable<Agent["runtimeBinding"]>,
		{ runtime: "hmux_managed_v1"; source: "ssh" }
	>,
	projection: ProjectedConversationIdentity,
): boolean {
	const fence = binding.stopFence;
	return fence !== undefined && sameHmuxManagedGeneration(fence, projection);
}

function validDecimalU64(value: string, nonZero = false): boolean {
	if (!DECIMAL_U64.test(value) || (nonZero && value === "0")) return false;
	return BigInt(value) <= MAX_U64;
}

function validProjection(value: ProjectedConversationIdentity): boolean {
	return (
		SAFE_ID.test(value.sessionId) &&
		SAFE_ID.test(value.workspaceId) &&
		SAFE_ID.test(value.runnerPrincipal) &&
		SAFE_ID.test(value.runnerInstance) &&
		validDecimalU64(value.channelEpoch, true) &&
		SAFE_ID.test(value.hostInstanceId) &&
		SAFE_ID.test(value.terminalEpoch) &&
		validDecimalU64(value.revision, true) &&
		validDecimalU64(value.observedThroughOutputSeq) &&
		SAFE_ID.test(value.providerId) &&
		PROVIDER_IDS.has(value.providerId) &&
		SAFE_ID.test(value.conversationId) &&
		(value.source === "launch_request" || value.source === "provider_event")
	);
}

/** Apply a Host-owned projection only to its exact current managed binding.
 * A changed Host/terminal fence is accepted only when no projection has yet
 * been committed for this binding; within one fence revisions must increase. */
export function applyProjectedConversationIdentity(
	agents: readonly Agent[],
	projection: ProjectedConversationIdentity,
	currentTerminalEpoch?: string,
): readonly Agent[] {
	if (
		!validProjection(projection) ||
		(currentTerminalEpoch !== undefined &&
			currentTerminalEpoch !== projection.terminalEpoch)
	) {
		return agents;
	}
	let changed = false;
	const next = agents.map((agent) => {
		const binding = agent.runtimeBinding;
		if (
			agent.sessionId !== projection.sessionId ||
			agent.provider !== projection.providerId ||
			binding?.runtime !== "hmux_managed_v1" ||
			binding.sessionId !== projection.sessionId ||
			binding.workspaceId !== projection.workspaceId ||
			(binding.source === "ssh" &&
				!projectionMatchesRemoteStopFence(binding, projection))
		) {
			return agent;
		}
		const current = binding.conversationIdentity;
		const projectedStopFence = stopFenceFromProjection(projection);
		const ready =
			agent.conversationId === projection.conversationId &&
			agent.conversationIdentity?.state === "ready" &&
			agent.conversationIdentity.conversationId === projection.conversationId;
		const currentBelongsToBinding =
			current?.sessionId === binding.sessionId &&
			current.workspaceId === binding.workspaceId;
		if (currentBelongsToBinding) {
			if (exactProjectionFence(current, projection)) {
				if (
					current.providerId !== projection.providerId ||
					current.conversationId !== projection.conversationId
				) {
					return agent;
				}
				if (BigInt(projection.revision) <= BigInt(current.revision)) {
					if (
						ready &&
						sameHmuxManagedGeneration(binding.stopFence, projectedStopFence)
					) {
						return agent;
					}
					changed = true;
					return {
						...agent,
						conversationId: projection.conversationId,
						conversationIdentity: readinessFromEvidence(
							projection.conversationId,
						),
						runtimeBinding: {
							...binding,
							stopFence: projectedStopFence,
						},
					};
				}
			} else if (currentTerminalEpoch === undefined) {
				return agent;
			}
		}
		changed = true;
		return {
			...agent,
			conversationId: projection.conversationId,
			conversationIdentity: readinessFromEvidence(projection.conversationId),
			runtimeBinding: {
				...binding,
				stopFence: projectedStopFence,
				conversationIdentity: {
					schemaVersion: 1 as const,
					...projection,
				},
			},
		};
	});
	return changed ? next : agents;
}
