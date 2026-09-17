import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	inspectExact: vi.fn(),
	publishResume: vi.fn(),
	reconcile: vi.fn(),
	register: vi.fn(),
}));

vi.mock("@/lib/ipc/dureAgentRuntime", () => ({
	createDureAgentRuntimeClient: () => ({
		inspectExact: mocks.inspectExact,
		publishNativeResume: mocks.publishResume,
		reconcileNativeRehost: mocks.reconcile,
	}),
}));
vi.mock("@/lib/ipc/dureProviderCredentialProfile", () => ({
	registerDureProviderCredentialProfile: mocks.register,
}));

import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";
import {
	commitManagedAgentNativeRehost,
	commitManagedAgentNativeResume,
} from "@/lib/sessions/managed/managedAgentRehostCommit";
import type { ManagedAgentRehostSyncPayload } from "@/lib/sessions/managed/managedAgentRehostSyncContract";
import { managedBindingFixture, stopFenceFixture } from "@/test/agentFixtures";

const sourceFence = stopFenceFixture({
	runnerPrincipal: "source-runner",
	runnerInstance: "source-instance",
	channelEpoch: "4",
	hostInstanceId: "source-host",
	terminalEpoch: "source-terminal",
});
const targetFence = stopFenceFixture({
	runnerPrincipal: "target-runner",
	runnerInstance: "target-instance",
	channelEpoch: "5",
	hostInstanceId: "target-host",
	terminalEpoch: "target-terminal",
});
const routeAuthority: DureBackendRouteAuthorityV1 = {
	schemaVersion: 1,
	profileId: "local",
	revision: `sha256:${"a".repeat(64)}`,
	backend: { id: "backend-local", generation: "generation-1" },
	target: { source: "local", hostId: "local" },
};

function payload(
	targetCredentialId: string | null,
): ManagedAgentRehostSyncPayload {
	return {
		schemaVersion: 2,
		operationId: "rehost-operation-1",
		launchKind: "exact_resume",
		sourcePermissionMode: "bypass_approvals",
		permissionMode: "bypass_approvals",
		agentId: "agent-1",
		agentName: "agent-one",
		projectId: "project-1",
		providerId: "codex",
		sourceBinding: managedBindingFixture({
			sessionId: "source-session",
			workspaceId: "workspace-1",
			credentialId: "account-a",
			stopFence: sourceFence,
		}),
		sourceConversationId: "conversation-1",
		backendRouteAuthority: routeAuthority,
		cwd: "/repo/worktree",
		conversationId: "conversation-1",
		desktopId: "desktop-1",
		panelId: "agent:agent-1",
		binding: managedBindingFixture({
			sessionId: "target-session",
			workspaceId: "workspace-1",
			credentialId: targetCredentialId ?? undefined,
			stopFence: targetFence,
		}),
		targetCredentialId,
	};
}

function backendReceipt(
	executionProfile:
		| { kind: "provider_default" }
		| {
				kind: "credential_reference";
				reference_id: string;
				credential_generation: string | null;
		  },
) {
	return {
		agentId: "agent-1",
		providerId: "codex",
		interactionProfile: "native_cli",
		executionProfile,
		providerConversationRef: "conversation-1",
		sessionId: "target-session",
		workspaceId: "workspace-1",
		launchIdempotencyKey: "create-1",
		stopFence: targetFence,
		backend: routeAuthority.backend,
		backendProfileId: "local",
		routeAuthority,
		selectionRevision: 2,
		launchSelection: {
			model: null,
			effort: null,
			permissionMode: "default",
		},
	};
}

describe("managed rehost backend commit", () => {
	beforeEach(() => {
		mocks.inspectExact.mockReset();
		mocks.publishResume.mockReset();
		mocks.reconcile.mockReset();
		mocks.register.mockReset();
		mocks.inspectExact.mockResolvedValue({
			state: "stable",
			...backendReceipt({ kind: "provider_default" }),
			sessionId: "source-session",
			launchIdempotencyKey: "create-source",
			stopFence: sourceFence,
			selectionRevision: 1,
		});
	});

	it("publishes an already-launched Resume target without client source authority", async () => {
		const request = {
			...payload("account-b"),
			operationId: "resume-operation-1",
			launchKind: "resume_new_host" as const,
			binding: managedBindingFixture({
				sessionId: "target-session",
				workspaceId: "workspace-1",
				credentialId: "account-b",
				createIdempotencyKey: "resume-create-1",
				stopFence: targetFence,
			}),
		};
		const receipt = {
			...backendReceipt({
				kind: "credential_reference" as const,
				reference_id: "account-b",
				credential_generation: null,
			}),
			launchIdempotencyKey: "resume-create-1",
			launchSelection: {
				model: null,
				effort: null,
				permissionMode: "skip_permissions" as const,
			},
		};
		mocks.inspectExact.mockResolvedValueOnce({ state: "repair_required" });
		mocks.publishResume.mockResolvedValueOnce(receipt);
		mocks.register.mockRejectedValueOnce(new Error("registry unavailable"));

		await expect(
			commitManagedAgentNativeResume(request, routeAuthority, {
				accounts: [
					{
						id: "account-b",
						provider: "codex",
						name: "B",
						dir: "/profiles/codex-b",
					},
				],
			}),
		).resolves.toEqual(receipt);

		expect(mocks.publishResume).toHaveBeenCalledWith({
			agentId: "agent-1",
			operationId: "resume-operation-1",
			providerId: "codex",
			targetCredential: {
				kind: "credential_reference",
				referenceId: "account-b",
			},
			providerConversationRef: "conversation-1",
			permissionMode: "skip_permissions",
			launchIdempotencyKey: "resume-create-1",
			target: {
				...targetFence,
				sessionId: "target-session",
				workspaceId: "workspace-1",
			},
			routeAuthority,
		});
		expect(mocks.publishResume.mock.calls[0][0]).not.toHaveProperty("source");
		expect(mocks.reconcile).not.toHaveBeenCalled();
		expect(mocks.register).toHaveBeenCalledOnce();
	});

	it("hands an unmanaged successor to the shared checkpoint adoption path", async () => {
		mocks.inspectExact.mockResolvedValueOnce({ state: "unmanaged" });

		await expect(
			commitManagedAgentNativeRehost(payload("account-b"), routeAuthority, {
				accounts: [
					{
						id: "account-b",
						provider: "codex",
						name: "B",
						dir: "/profiles/codex-b",
					},
				],
			}),
		).resolves.toBeUndefined();

		expect(mocks.register).not.toHaveBeenCalled();
		expect(mocks.reconcile).not.toHaveBeenCalled();
	});

	it("replays the exact target after unmanaged checkpoint adoption publishes Native revision one", async () => {
		const request = payload("account-b");
		const accounts = [
			{
				id: "account-b",
				provider: "codex" as const,
				name: "B",
				dir: "/profiles/codex-b",
			},
		];
		mocks.inspectExact.mockResolvedValueOnce({ state: "unmanaged" });

		await expect(
			commitManagedAgentNativeRehost(request, routeAuthority, { accounts }),
		).resolves.toBeUndefined();

		const adopted = {
			...backendReceipt({
				kind: "credential_reference" as const,
				reference_id: "account-b",
				credential_generation: null,
			}),
			selectionRevision: 1,
			launchIdempotencyKey: null,
		};
		mocks.inspectExact.mockResolvedValueOnce({ state: "stable", ...adopted });

		await expect(
			commitManagedAgentNativeRehost(request, routeAuthority, { accounts }),
		).resolves.toEqual(adopted);
		expect(mocks.register).not.toHaveBeenCalled();
		expect(mocks.reconcile).not.toHaveBeenCalled();
	});

	it.each(["transitioning", "closed"] as const)(
		"delegates backend state %s to the authoritative reconciliation CAS",
		async (state) => {
			mocks.inspectExact.mockResolvedValueOnce({ state });
			const receipt = backendReceipt({ kind: "provider_default" });
			mocks.reconcile.mockResolvedValueOnce(receipt);

			await expect(
				commitManagedAgentNativeRehost(payload(null), routeAuthority, {
					accounts: [],
				}),
			).resolves.toEqual(receipt);

			expect(mocks.register).not.toHaveBeenCalled();
			expect(mocks.reconcile).toHaveBeenCalledOnce();
		},
	);

	it("delegates a repair-required durable successor to backend reconciliation", async () => {
		mocks.inspectExact.mockResolvedValueOnce({ state: "repair_required" });
		const receipt = backendReceipt({ kind: "provider_default" });
		mocks.reconcile.mockResolvedValueOnce(receipt);

		await expect(
			commitManagedAgentNativeRehost(payload(null), routeAuthority, {
				accounts: [],
			}),
		).resolves.toEqual(receipt);

		expect(mocks.register).not.toHaveBeenCalled();
		expect(mocks.reconcile).toHaveBeenCalledOnce();
	});

	it("does not echo stale frontend source profile or permission into authority", async () => {
		mocks.reconcile.mockResolvedValue(
			backendReceipt({ kind: "provider_default" }),
		);
		const requestPayload = payload(null);

		await commitManagedAgentNativeRehost(requestPayload, routeAuthority, {
			accounts: [],
		});

		expect(mocks.register).not.toHaveBeenCalled();
		expect(mocks.reconcile).toHaveBeenCalledWith(
			expect.objectContaining({
				targetCredential: { kind: "provider_default" },
			}),
		);
		const request = mocks.reconcile.mock.calls[0][0];
		expect(request).not.toHaveProperty("sourceExecutionProfile");
		expect(request).not.toHaveProperty("permissionMode");
	});

	it("accepts the provider conversation discovered by a committed fresh replacement", async () => {
		const requestPayload = {
			...payload(null),
			launchKind: "fresh" as const,
			conversationId: null,
		};
		const receipt = {
			...backendReceipt({ kind: "provider_default" }),
			providerConversationRef: "conversation-fresh",
		};
		mocks.reconcile.mockResolvedValue(receipt);

		await expect(
			commitManagedAgentNativeRehost(requestPayload, routeAuthority, {
				accounts: [],
			}),
		).resolves.toEqual(receipt);
	});

	it("replays only the same committed conversation refinement for a fresh replacement", async () => {
		const requestPayload = {
			...payload(null),
			launchKind: "fresh" as const,
			conversationId: "conversation-fresh",
		};
		const receipt = {
			...backendReceipt({ kind: "provider_default" }),
			providerConversationRef: "conversation-fresh",
		};
		mocks.reconcile.mockResolvedValueOnce(receipt);

		await expect(
			commitManagedAgentNativeRehost(requestPayload, routeAuthority, {
				accounts: [],
			}),
		).resolves.toEqual(receipt);

		mocks.reconcile.mockResolvedValueOnce({
			...receipt,
			providerConversationRef: "conversation-other",
		});
		await expect(
			commitManagedAgentNativeRehost(requestPayload, routeAuthority, {
				accounts: [],
			}),
		).rejects.toThrow("managed_rehost_backend_receipt_mismatch");
	});

	it("rejects a changed provider conversation for an exact resume", async () => {
		mocks.reconcile.mockResolvedValue({
			...backendReceipt({ kind: "provider_default" }),
			providerConversationRef: "conversation-other",
		});

		await expect(
			commitManagedAgentNativeRehost(payload(null), routeAuthority, {
				accounts: [],
			}),
		).rejects.toThrow("managed_rehost_backend_receipt_mismatch");
	});

	it("registers the exact target generation for an A-to-B switch", async () => {
		const target = {
			kind: "credential_reference" as const,
			reference_id: "account-b",
			credential_generation: "account-b-generation-7",
		};
		mocks.register.mockResolvedValue(target);
		mocks.reconcile.mockResolvedValue(backendReceipt(target));

		await commitManagedAgentNativeRehost(payload("account-b"), routeAuthority, {
			accounts: [
				{
					id: "account-b",
					provider: "codex",
					name: "B",
					dir: "/profiles/codex-b",
				},
			],
		});

		expect(mocks.reconcile).toHaveBeenCalledWith(
			expect.objectContaining({
				targetCredential: {
					kind: "credential_reference",
					referenceId: "account-b",
				},
			}),
		);
	});

	it("lets CP resolve its registered generation when Hmux is durable but CP is still source", async () => {
		const target = {
			kind: "credential_reference" as const,
			reference_id: "account-b",
			credential_generation: "account-b-generation-7",
		};
		mocks.inspectExact.mockResolvedValue({
			state: "stable",
			...backendReceipt({
				kind: "credential_reference",
				reference_id: "account-a",
				credential_generation: "account-a-generation-3",
			}),
			sessionId: "source-session",
			launchIdempotencyKey: "create-old",
			stopFence: sourceFence,
			selectionRevision: 1,
		});
		mocks.reconcile.mockResolvedValue(backendReceipt(target));

		await commitManagedAgentNativeRehost(payload("account-b"), routeAuthority, {
			accounts: [],
		});

		expect(mocks.register).not.toHaveBeenCalled();
		expect(mocks.reconcile).toHaveBeenCalledWith(
			expect.objectContaining({
				targetCredential: {
					kind: "credential_reference",
					referenceId: "account-b",
				},
			}),
		);
	});

	it("converges a lost response from the exact inspected successor", async () => {
		const target = {
			kind: "credential_reference" as const,
			reference_id: "account-b",
			credential_generation: "account-b-generation-7",
		};
		const receipt = backendReceipt(target);
		mocks.inspectExact.mockResolvedValue({ state: "stable", ...receipt });

		await commitManagedAgentNativeRehost(payload("account-b"), routeAuthority, {
			accounts: [],
		});

		expect(mocks.inspectExact).toHaveBeenCalledWith("agent-1", routeAuthority);
		expect(mocks.register).not.toHaveBeenCalled();
		expect(mocks.reconcile).not.toHaveBeenCalled();
	});

	it("uses the committed target credential instead of a stale frontend candidate", async () => {
		const committedTarget = {
			kind: "credential_reference" as const,
			reference_id: "account-b",
			credential_generation: "account-b-generation-7",
		};
		const receipt = backendReceipt(committedTarget);
		mocks.inspectExact.mockResolvedValue({ state: "stable", ...receipt });

		await expect(
			commitManagedAgentNativeRehost(payload("account-stale"), routeAuthority, {
				accounts: [],
			}),
		).resolves.toEqual(receipt);

		expect(mocks.register).not.toHaveBeenCalled();
		expect(mocks.reconcile).not.toHaveBeenCalled();
	});
});
