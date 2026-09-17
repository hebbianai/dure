import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ inspectExact: vi.fn() }));

vi.mock("@/lib/ipc/dureAgentRuntime", () => ({
	createDureAgentRuntimeClient: () => ({ inspectExact: mocks.inspectExact }),
}));

import type {
	HmuxExistingManagedWriterInspection,
	HmuxManagedRehostResolution,
} from "@/lib/ipc";
import {
	type ManagedRehostLineageObservation,
	reconcileManagedAgentDurableSuccessor,
	resolveManagedAgentDurableSuccessor,
	sessionMatchesManagedRehostGeneration,
} from "@/lib/sessions/managed/managedAgentDurableSuccessor";
import {
	type ManagedAgentDurableSuccessorSource,
	managedAgentDurableSuccessorSyncPayload,
} from "@/lib/sessions/managed/managedAgentExistingWriter";
import {
	managedAgentFixture,
	managedBindingFixture,
	stopFenceFixture,
} from "@/test/agentFixtures";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";

const sourceFence = stopFenceFixture({
	runnerInstance: "runner-source",
	hostInstanceId: "host-source",
	terminalEpoch: "terminal-source",
});
const finalFence = stopFenceFixture({
	runnerInstance: "runner-final",
	channelEpoch: "9",
	hostInstanceId: "host-final",
	terminalEpoch: "terminal-final",
});

const source: ManagedAgentDurableSuccessorSource = {
	agentId: "agent-1",
	agentName: "research",
	projectId: "project-1",
	providerId: "codex",
	sourceBinding: managedBindingFixture({
		sessionId: "session-source",
		workspaceId: "workspace-1",
		stopFence: sourceFence,
	}),
	sourceConversationId: "conversation-1",
	sourcePaneState: "present",
	conversationId: "conversation-1",
	cwd: "/repo/research",
	desktopId: "space-1",
	panelId: "agent:agent-1",
	permissionMode: "default",
	sourcePermissionMode: "default",
	backendRouteAuthority: testDureBackendRouteAuthority(
		"backend-local",
		"generation-local",
	),
	accounts: [
		{
			id: "account-a",
			provider: "codex",
			name: "A",
			dir: "/profiles/codex-a",
		},
		{
			id: "account-b",
			provider: "codex",
			name: "B",
			dir: "/profiles/codex-b",
		},
	],
};

const resolvedLineage: Extract<
	HmuxManagedRehostResolution,
	{ state: "resolved" }
> = {
	schema: "hmux-managed-rehost-resolution-v1",
	schemaVersion: 1,
	state: "resolved",
	operationIds: ["rehost-operation-1", "rehost-operation-2"],
	sourceGeneration: {
		sessionId: "session-source",
		workspaceId: "workspace-1",
		...sourceFence,
	},
	currentGeneration: {
		sessionId: "session-final",
		workspaceId: "workspace-1",
		...finalFence,
	},
	providerId: "codex",
	permissionMode: "default",
};

const writer: HmuxExistingManagedWriterInspection = {
	session: {
		sessionId: "session-final",
		workspaceId: "workspace-1",
		sessionClass: "managed",
		lifecycle: "ready",
		health: "current_healthy",
		inputAllowed: true,
		terminalEpoch: finalFence.terminalEpoch,
		stopFence: finalFence,
		outputSeq: "42",
		capabilities: [],
	},
	idempotencyKey: "create-final",
	conversationId: "conversation-1",
	permissionMode: "default",
};

function committedCredentialReceipt(
	executionProfile:
		| { kind: "provider_default" }
		| {
				kind: "credential_reference";
				reference_id: string;
				credential_generation: string;
		  },
) {
	return {
		state: "stable",
		agentId: source.agentId,
		providerId: source.providerId,
		interactionProfile: "native_cli",
		executionProfile,
		providerConversationRef: "conversation-2",
		sessionId: "session-final",
		workspaceId: "workspace-1",
		launchIdempotencyKey: writer.idempotencyKey,
		stopFence: finalFence,
	};
}

describe("managed Agent durable successor", () => {
	beforeEach(() => {
		mocks.inspectExact.mockReset();
	});

	it("projects an authoritative final permission mode while retaining the root mode as the source fence", async () => {
		const finalLineage = {
			...resolvedLineage,
			permissionMode: "bypass_approvals" as const,
		};
		const finalWriter = {
			...writer,
			permissionMode: "bypass_approvals" as const,
		};
		const agent = managedAgentFixture({
			id: source.agentId,
			name: source.agentName,
			projectId: source.projectId,
			provider: source.providerId,
			worktreePath: source.cwd,
			sessionId: source.sourceBinding.sessionId,
			conversationId: source.conversationId,
			runtimeBinding: source.sourceBinding,
			skipPermissions: false,
		});

		const reconciliation = await reconcileManagedAgentDurableSuccessor(
			agent,
			source.desktopId,
			source.panelId,
			{},
			{
				runtime: {
					resolveManagedRehost: vi.fn().mockResolvedValue(finalLineage),
					inspectExistingWriter: vi.fn().mockResolvedValue(finalWriter),
					resolveRouteAuthority: vi
						.fn()
						.mockResolvedValue(source.backendRouteAuthority),
					accounts: () => source.accounts,
				},
			},
		);

		expect(reconciliation?.payload).toMatchObject({
			sourcePermissionMode: "default",
			permissionMode: "bypass_approvals",
		});
	});

	it("uses the Host-owned binding conversation when the top-level projection is stale", async () => {
		const binding = managedBindingFixture({
			...source.sourceBinding,
			conversationIdentity: {
				schemaVersion: 1,
				sessionId: source.sourceBinding.sessionId,
				workspaceId: source.sourceBinding.workspaceId,
				...sourceFence,
				revision: "3",
				observedThroughOutputSeq: "9",
				providerId: source.providerId,
				conversationId: source.conversationId,
				source: "provider_event",
			},
		});
		const agent = managedAgentFixture({
			id: source.agentId,
			name: source.agentName,
			projectId: source.projectId,
			provider: source.providerId,
			worktreePath: source.cwd,
			sessionId: binding.sessionId,
			conversationId: undefined,
			runtimeBinding: binding,
		});
		const finalLineage = {
			...resolvedLineage,
			launchIdentity: { conversationId: "conversation-2" },
		};

		const reconciliation = await reconcileManagedAgentDurableSuccessor(
			agent,
			source.desktopId,
			source.panelId,
			{},
			{
				runtime: {
					resolveManagedRehost: vi.fn().mockResolvedValue(finalLineage),
					inspectExistingWriter: vi.fn().mockResolvedValue({
						...writer,
						conversationId: "conversation-2",
					}),
					resolveRouteAuthority: vi
						.fn()
						.mockResolvedValue(source.backendRouteAuthority),
					accounts: () => source.accounts,
				},
			},
		);

		expect(reconciliation?.payload).toMatchObject({
			sourceConversationId: source.conversationId,
			conversationId: "conversation-2",
		});
	});

	it("accepts a ready legacy census that predates the input-allowed projection", () => {
		const legacySession = { ...writer.session, inputAllowed: undefined };

		expect(
			sessionMatchesManagedRehostGeneration(
				legacySession,
				resolvedLineage.currentGeneration,
			),
		).toBe(true);
	});

	it("selects the final writer of a multi-hop lineage and confirms it with one CAS reread", async () => {
		const resolveManagedRehost = vi.fn().mockResolvedValue(resolvedLineage);
		const inspectExistingWriter = vi.fn().mockResolvedValue(writer);

		const result = await resolveManagedAgentDurableSuccessor(source, {
			resolveManagedRehost,
			inspectExistingWriter,
		});

		expect(result).toEqual({
			state: "resolved",
			operationId: "rehost-operation-2",
			writer,
			launchKind: "exact_resume",
			launchReference: undefined,
			providerConversationRef: "conversation-1",
			targetCredentialId: null,
		});
		expect(inspectExistingWriter).toHaveBeenCalledWith(
			source,
			"session-final",
			{ conversationId: "conversation-1", launchReference: undefined },
		);
		expect(resolveManagedRehost).toHaveBeenCalledTimes(2);
	});

	it("inspects a known exact successor with the final launch identity", async () => {
		const finalIdentity = {
			...resolvedLineage,
			launchIdentity: {
				launchReference: "account-b",
				conversationId: "conversation-2",
			},
		};
		const inspectExistingWriter = vi.fn().mockResolvedValue({
			...writer,
			conversationId: "conversation-2",
			launchReference: "account-b",
		});

		const result = await resolveManagedAgentDurableSuccessor(source, {
			resolveManagedRehost: vi.fn().mockResolvedValue(finalIdentity),
			inspectExistingWriter,
		});

		expect(inspectExistingWriter).toHaveBeenCalledWith(
			source,
			"session-final",
			{ conversationId: "conversation-2", launchReference: "account-b" },
		);
		expect(result).toMatchObject({
			state: "resolved",
			launchKind: "exact_resume",
			providerConversationRef: "conversation-2",
			targetCredentialId: "account-b",
		});
		if (result.state !== "resolved") throw new Error("expected successor");
		expect(
			managedAgentDurableSuccessorSyncPayload(
				source,
				result,
				result.operationId,
			),
		).toMatchObject({
			launchKind: "exact_resume",
			conversationId: "conversation-2",
			targetCredentialId: "account-b",
			binding: { credentialId: "account-b" },
		});
	});

	it("proves a known fresh successor with its live conversation but preserves a fresh sync", async () => {
		const freshLineage = {
			...resolvedLineage,
			launchIdentity: { launchReference: "account-b" },
		};
		const freshWriter = {
			...writer,
			conversationId: "conversation-live",
			launchReference: "account-b",
		};
		const inspectExistingWriter = vi.fn().mockResolvedValue(freshWriter);
		const inspectConversationIdentity = vi.fn().mockResolvedValue({
			sessionId: "session-final",
			workspaceId: "workspace-1",
			providerId: "codex",
			conversationId: "conversation-live",
		});

		const result = await resolveManagedAgentDurableSuccessor(source, {
			resolveManagedRehost: vi.fn().mockResolvedValue(freshLineage),
			inspectExistingWriter,
			inspectConversationIdentity,
		});

		expect(inspectExistingWriter).toHaveBeenCalledWith(
			source,
			"session-final",
			{
				conversationId: "conversation-live",
				launchReference: "account-b",
			},
		);
		if (result.state !== "resolved") throw new Error("expected successor");
		expect(result.writer.conversationId).toBe("conversation-live");
		expect(
			managedAgentDurableSuccessorSyncPayload(
				source,
				result,
				result.operationId,
			),
		).toMatchObject({
			launchKind: "fresh",
			conversationId: null,
			targetCredentialId: "account-b",
			binding: { credentialId: "account-b" },
		});
	});

	it("projects provider default when a known exact identity omits its launch reference", async () => {
		const defaultLineage = {
			...resolvedLineage,
			launchIdentity: { conversationId: "conversation-2" },
		};
		const defaultWriter = {
			...writer,
			conversationId: "conversation-2",
		};

		const result = await resolveManagedAgentDurableSuccessor(source, {
			resolveManagedRehost: vi.fn().mockResolvedValue(defaultLineage),
			inspectExistingWriter: vi.fn().mockResolvedValue(defaultWriter),
		});

		expect(result).toMatchObject({
			state: "resolved",
			launchKind: "exact_resume",
			providerConversationRef: "conversation-2",
			targetCredentialId: null,
		});
		expect(mocks.inspectExact).not.toHaveBeenCalled();
	});

	it("uses only a CP-committed final credential for an opaque known launch reference", async () => {
		const opaqueLineage = {
			...resolvedLineage,
			launchIdentity: {
				launchReference: "credential+opaque-final",
				conversationId: "conversation-2",
			},
		};
		const opaqueWriter = {
			...writer,
			conversationId: "conversation-2",
			launchReference: "credential+opaque-final",
		};
		mocks.inspectExact.mockResolvedValue(
			committedCredentialReceipt({
				kind: "credential_reference",
				reference_id: "account-b",
				credential_generation: "account-b-generation-2",
			}),
		);

		const result = await resolveManagedAgentDurableSuccessor(source, {
			resolveManagedRehost: vi.fn().mockResolvedValue(opaqueLineage),
			inspectExistingWriter: vi.fn().mockResolvedValue(opaqueWriter),
		});

		expect(result).toMatchObject({
			state: "resolved",
			launchReference: "credential+opaque-final",
			targetCredentialId: "account-b",
		});
		expect(mocks.inspectExact).toHaveBeenCalledWith(
			source.agentId,
			source.backendRouteAuthority,
		);
		if (result.state !== "resolved") throw new Error("expected successor");
		expect(
			managedAgentDurableSuccessorSyncPayload(
				source,
				result,
				result.operationId,
			).binding.credentialId,
		).toBe("account-b");
	});

	it("uses CP to disambiguate a direct account id from another account's directory alias", async () => {
		const ambiguousSource = {
			...source,
			accounts: [
				{
					...source.accounts[0],
					id: "codex-shared",
				},
				{
					...source.accounts[1],
					dir: "/profiles/codex-shared",
				},
			],
		};
		const finalIdentity = {
			...resolvedLineage,
			launchIdentity: {
				launchReference: "codex-shared",
				conversationId: "conversation-2",
			},
		};
		mocks.inspectExact.mockResolvedValue(
			committedCredentialReceipt({
				kind: "credential_reference",
				reference_id: "account-b",
				credential_generation: "account-b-generation-2",
			}),
		);

		const result = await resolveManagedAgentDurableSuccessor(ambiguousSource, {
			resolveManagedRehost: vi.fn().mockResolvedValue(finalIdentity),
			inspectExistingWriter: vi.fn().mockResolvedValue({
				...writer,
				conversationId: "conversation-2",
				launchReference: "codex-shared",
			}),
		});

		expect(result).toMatchObject({
			state: "resolved",
			targetCredentialId: "account-b",
		});
		expect(mocks.inspectExact).toHaveBeenCalledOnce();
	});

	it("uses CP to disambiguate a directory alias shared by two accounts", async () => {
		const ambiguousSource = {
			...source,
			accounts: source.accounts.map((account) => ({
				...account,
				dir: "/profiles/codex-shared",
			})),
		};
		const finalIdentity = {
			...resolvedLineage,
			launchIdentity: {
				launchReference: "codex-shared",
				conversationId: "conversation-2",
			},
		};
		mocks.inspectExact.mockResolvedValue(
			committedCredentialReceipt({
				kind: "credential_reference",
				reference_id: "account-b",
				credential_generation: "account-b-generation-2",
			}),
		);

		const result = await resolveManagedAgentDurableSuccessor(ambiguousSource, {
			resolveManagedRehost: vi.fn().mockResolvedValue(finalIdentity),
			inspectExistingWriter: vi.fn().mockResolvedValue({
				...writer,
				conversationId: "conversation-2",
				launchReference: "codex-shared",
			}),
		});

		expect(result).toMatchObject({
			state: "resolved",
			targetCredentialId: "account-b",
		});
		expect(mocks.inspectExact).toHaveBeenCalledOnce();
	});

	it("fails closed when a direct-id-to-directory-alias collision has no CP credential proof", async () => {
		const ambiguousSource = {
			...source,
			accounts: [
				{
					...source.accounts[0],
					id: "codex-shared",
				},
				{
					...source.accounts[1],
					dir: "/profiles/codex-shared",
				},
			],
		};
		const finalIdentity = {
			...resolvedLineage,
			launchIdentity: {
				launchReference: "codex-shared",
				conversationId: "conversation-2",
			},
		};
		mocks.inspectExact.mockResolvedValue({ state: "unmanaged" });

		await expect(
			resolveManagedAgentDurableSuccessor(ambiguousSource, {
				resolveManagedRehost: vi.fn().mockResolvedValue(finalIdentity),
				inspectExistingWriter: vi.fn().mockResolvedValue({
					...writer,
					conversationId: "conversation-2",
					launchReference: "codex-shared",
				}),
			}),
		).rejects.toMatchObject({
			code: "pane_changed",
			message:
				"managed rehost launch reference has no canonical target credential",
		});
		expect(mocks.inspectExact).toHaveBeenCalledOnce();
	});

	it("finds an exact account id without parsing unrelated legacy directories", async () => {
		const directSource = {
			...source,
			accounts: [
				{ ...source.accounts[0], dir: "/legacy/unreviewed-profile" },
				source.accounts[1],
			],
		};
		const finalIdentity = {
			...resolvedLineage,
			launchIdentity: {
				launchReference: "account-b",
				conversationId: "conversation-2",
			},
		};

		const result = await resolveManagedAgentDurableSuccessor(directSource, {
			resolveManagedRehost: vi.fn().mockResolvedValue(finalIdentity),
			inspectExistingWriter: vi.fn().mockResolvedValue({
				...writer,
				conversationId: "conversation-2",
				launchReference: "account-b",
			}),
		});

		expect(result).toMatchObject({
			state: "resolved",
			targetCredentialId: "account-b",
		});
		expect(mocks.inspectExact).not.toHaveBeenCalled();
	});

	it("refuses an opaque reference while CP still describes the source", async () => {
		const opaqueLineage = {
			...resolvedLineage,
			launchIdentity: {
				launchReference: "credential+opaque-final",
				conversationId: "conversation-2",
			},
		};
		mocks.inspectExact.mockResolvedValue({
			...committedCredentialReceipt({
				kind: "credential_reference",
				reference_id: "account-a",
				credential_generation: "account-a-generation-1",
			}),
			sessionId: "session-source",
			launchIdempotencyKey: "create-source",
			stopFence: sourceFence,
		});

		await expect(
			resolveManagedAgentDurableSuccessor(source, {
				resolveManagedRehost: vi.fn().mockResolvedValue(opaqueLineage),
				inspectExistingWriter: vi.fn().mockResolvedValue({
					...writer,
					conversationId: "conversation-2",
					launchReference: "credential+opaque-final",
				}),
			}),
		).rejects.toMatchObject({
			code: "pane_changed",
			message:
				"managed rehost launch reference has no canonical target credential",
		});
	});

	it("limits a legacy lineage to the verified root credential aliases", async () => {
		const legacySource: ManagedAgentDurableSuccessorSource = {
			...source,
			credentialId: "account-a",
			sourceBinding: managedBindingFixture({
				...source.sourceBinding,
				credentialId: "account-a",
			}),
		};
		const aliasWriter = {
			...writer,
			launchReference: "codex-a",
		};
		const inspectExistingWriter = vi
			.fn()
			.mockRejectedValueOnce(new Error("launch identity mismatch"))
			.mockResolvedValueOnce(aliasWriter);

		const result = await resolveManagedAgentDurableSuccessor(legacySource, {
			resolveManagedRehost: vi.fn().mockResolvedValue(resolvedLineage),
			inspectExistingWriter,
		});

		expect(inspectExistingWriter.mock.calls.map((call) => call[2])).toEqual([
			{
				conversationId: "conversation-1",
				launchReference: "account-a",
			},
			{
				conversationId: "conversation-1",
				launchReference: "codex-a",
			},
		]);
		if (result.state !== "resolved") throw new Error("expected successor");
		expect(result).toMatchObject({
			launchKind: "exact_resume",
			providerConversationRef: "conversation-1",
			launchReference: "codex-a",
			targetCredentialId: "account-a",
		});
		expect(
			managedAgentDurableSuccessorSyncPayload(
				legacySource,
				result,
				result.operationId,
			).binding.credentialId,
		).toBe("account-a");
	});

	it("keeps the exact legacy account id when its optional directory alias is malformed", async () => {
		const legacySource: ManagedAgentDurableSuccessorSource = {
			...source,
			credentialId: "account-a",
			accounts: [{ ...source.accounts[0], dir: "/legacy/profile" }],
			sourceBinding: managedBindingFixture({
				...source.sourceBinding,
				credentialId: "account-a",
			}),
		};
		const inspectExistingWriter = vi.fn().mockResolvedValue({
			...writer,
			launchReference: "account-a",
		});

		const result = await resolveManagedAgentDurableSuccessor(legacySource, {
			resolveManagedRehost: vi.fn().mockResolvedValue(resolvedLineage),
			inspectExistingWriter,
		});

		expect(result).toMatchObject({
			state: "resolved",
			launchReference: "account-a",
			targetCredentialId: "account-a",
		});
		expect(inspectExistingWriter).toHaveBeenCalledOnce();
	});

	it("refuses a launch identity change during the lineage CAS reread", async () => {
		const initial = {
			...resolvedLineage,
			launchIdentity: {
				launchReference: "account-a",
				conversationId: "conversation-1",
			},
		};
		const changed = {
			...initial,
			launchIdentity: {
				launchReference: "account-b",
				conversationId: "conversation-2",
			},
		};

		await expect(
			resolveManagedAgentDurableSuccessor(source, {
				resolveManagedRehost: vi
					.fn()
					.mockResolvedValueOnce(initial)
					.mockResolvedValueOnce(changed),
				inspectExistingWriter: vi.fn().mockResolvedValue(writer),
			}),
		).rejects.toMatchObject({
			code: "pane_changed",
			message: "managed rehost lineage changed during successor inspection",
		});
	});

	it("distinguishes unavailable launch identity from a known fresh identity in the CAS", async () => {
		await expect(
			resolveManagedAgentDurableSuccessor(source, {
				resolveManagedRehost: vi
					.fn()
					.mockResolvedValueOnce(resolvedLineage)
					.mockResolvedValueOnce({
						...resolvedLineage,
						launchIdentity: {},
					}),
				inspectExistingWriter: vi.fn().mockResolvedValue(writer),
			}),
		).rejects.toMatchObject({
			code: "pane_changed",
			message: "managed rehost lineage changed during successor inspection",
		});
	});

	it("refuses to project a writer when the lineage changes during inspection", async () => {
		const newerLineage: typeof resolvedLineage = {
			...resolvedLineage,
			operationIds: [...resolvedLineage.operationIds, "rehost-operation-3"],
			currentGeneration: {
				...resolvedLineage.currentGeneration,
				sessionId: "session-newer",
				runnerInstance: "runner-newer",
			},
		};
		const resolveManagedRehost = vi
			.fn()
			.mockResolvedValueOnce(resolvedLineage)
			.mockResolvedValueOnce(newerLineage);

		await expect(
			resolveManagedAgentDurableSuccessor(source, {
				resolveManagedRehost,
				inspectExistingWriter: vi.fn().mockResolvedValue(writer),
			}),
		).rejects.toMatchObject({
			code: "pane_changed",
			message: "managed rehost lineage changed during successor inspection",
		});
	});

	it("preserves a retry-required lineage without inspecting a target", async () => {
		const retry: ManagedRehostLineageObservation = {
			state: "retry_required",
			operationId: "rehost-operation-1",
		};
		const inspectExistingWriter = vi.fn();

		await expect(
			resolveManagedAgentDurableSuccessor(
				source,
				{
					resolveManagedRehost: vi.fn(),
					inspectExistingWriter,
				},
				retry,
			),
		).resolves.toEqual(retry);
		expect(inspectExistingWriter).not.toHaveBeenCalled();
	});
});
