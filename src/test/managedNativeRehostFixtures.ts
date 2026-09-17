import type { DureBackendInvoke } from "@/lib/ipc/dureBackend";
import type { HmuxExactManagedCreateReceipt } from "@/lib/ipc/hmuxContracts";
import type { ManagedAgentRehostSyncPayload } from "@/lib/sessions/managed/managedAgentRehostSyncContract";
import {
	agentRuntimeBackendEnvelope,
	agentRuntimeProjectionContext,
	nativeRuntimeReceipt,
} from "@/test/dureAgentRuntimeFixtures";
import { managedRehostNotificationFixture } from "@/test/managedRehostFixtures";

const envelope = agentRuntimeBackendEnvelope();

export function nativeResumeCreateFixture(
	generation: number,
): HmuxExactManagedCreateReceipt {
	const payload = nativeResumePayloadFixture(generation);
	return {
		idempotencyKey: payload.binding.createIdempotencyKey!,
		cwd: payload.cwd,
		outcome: "created",
		session: {
			sessionId: payload.binding.sessionId,
			workspaceId: payload.binding.workspaceId,
			sessionClass: "managed",
			lifecycle: "ready",
			terminalEpoch: payload.binding.stopFence!.terminalEpoch,
			stopFence: payload.binding.stopFence!,
			outputSeq: "0",
			capabilities: [],
		},
	};
}

export function nativeResumePayloadFixture(
	generation: number,
	credentialId: string | null = null,
): ManagedAgentRehostSyncPayload {
	const payload = managedRehostNotificationFixture(generation);
	return {
		...payload,
		launchKind: "resume_new_host",
		backendRouteAuthority: envelope.routeAuthority,
		targetCredentialId: credentialId,
		binding: { ...payload.binding, credentialId: credentialId ?? undefined },
	};
}

function receipt(payload: ManagedAgentRehostSyncPayload, revision: number) {
	const credentialId = payload.targetCredentialId ?? null;
	const base = nativeRuntimeReceipt(
		credentialId
			? {
					kind: "credential_reference",
					reference_id: credentialId,
					credential_generation: null,
				}
			: { kind: "provider_default" },
		revision,
		payload.binding.createIdempotencyKey,
	);
	return {
		...base,
		providerId: payload.providerId,
		providerConversationRef: payload.conversationId,
		permissionMode:
			payload.permissionMode === "bypass_approvals"
				? "skip_permissions"
				: "default",
		authority: {
			...base.authority,
			authority: {
				...base.authority.authority,
				...payload.binding.stopFence,
				runtimeWorkspaceId: payload.binding.workspaceId,
				binding: {
					...base.authority.authority.binding,
					sessionId: payload.binding.sessionId,
					providerConversationId: payload.conversationId,
					bindingGeneration: revision,
				},
			},
		},
	};
}

/** Control only the backend response boundary; real clients still parse and
 * check every envelope. Native QA keeps events and persistence unmodified. */
export function createNativeRehostBackendFixture(initialGeneration = 0) {
	let current = receipt(
		nativeResumePayloadFixture(initialGeneration),
		initialGeneration + 1,
	);
	const pending: Array<{
		sessionId: string;
		reply(): void;
		lose(): void;
	}> = [];
	const payloads = new Map<string, ManagedAgentRehostSyncPayload>();
	const handleRequest: DureBackendInvoke = async (command, args) => {
		const request = args as {
			operation: string;
			body: { agentId: string; operationId: string };
		};
		if (
			command !== "dure_backend_request" ||
			request.body.agentId !== "agent-1"
		) {
			throw new Error(`Unexpected fixture command: ${command}`);
		}
		if (request.operation === "agent_runtime.projection.inspect") {
			return {
				...envelope,
				result: {
					schemaVersion: 1,
					state: "stable",
					receipt: current,
					projectionContext: agentRuntimeProjectionContext("agent-1", "codex"),
				},
			};
		}
		const payload = payloads.get(request.body.operationId);
		if (
			(request.operation !== "agent_runtime.native_resume.publish" &&
				request.operation !== "agent_runtime.native_rehost.reconcile") ||
			!payload
		) {
			throw new Error(`Unexpected fixture operation: ${request.operation}`);
		}
		current = receipt(payload, current.selectionRevision + 1);
		const response = {
			...envelope,
			result: { schemaVersion: 1, receipt: current },
		};
		return new Promise((resolve, reject) => {
			pending.push({
				sessionId: payload.binding.sessionId,
				reply: () => resolve(response),
				lose: () => reject(new Error("Fixture response lost after commit")),
			});
		});
	};
	return {
		handleRequest,
		pending,
		currentSessionId: () => current.authority.authority.binding.sessionId,
		observeCredentialGeneration: (credentialGeneration: string) => {
			if (current.executionProfile.kind !== "credential_reference")
				throw new Error("Expected a fixture credential reference");
			current = {
				...current,
				executionProfile: {
					...current.executionProfile,
					credential_generation: credentialGeneration,
				},
			};
		},
		prepare: (
			payload: ManagedAgentRehostSyncPayload,
			conversationId?: string,
		) =>
			payloads.set(payload.operationId, {
				...payload,
				conversationId: conversationId ?? payload.conversationId,
			}),
	};
}
