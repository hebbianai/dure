import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	HmuxManagedRehostResolution,
	HmuxSessionSummary,
} from "@/lib/ipc";
import type { Agent } from "@/types";

const mocks = vi.hoisted(() => ({
	resolveSuccessor: vi.fn(),
	inspectSession: vi.fn(),
	inspectWriter: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({
	hmux: {
		resolveManagedRehost: mocks.resolveSuccessor,
		inspectExistingManagedWriter: mocks.inspectWriter,
	},
}));
vi.mock("@/lib/hmux/identity/exactHmuxSessionInspection", () => ({
	inspectHmuxSessionExact: mocks.inspectSession,
}));

import {
	ManagedConversationOwnershipUnavailableError,
	resolveManagedConversationOwnership,
	revalidateManagedConversationLaunchPermit,
} from "@/lib/sessions/managed/managedConversationOwnership";
import { useStore } from "@/store";
import {
	managedAgentFixture,
	managedBindingFixture,
} from "@/test/agentFixtures";

const sourceFence = {
	runnerPrincipal: "local-user",
	runnerInstance: "runner-source",
	channelEpoch: "1",
	hostInstanceId: "host-source",
	terminalEpoch: "terminal-source",
};

const successorFence = {
	...sourceFence,
	runnerInstance: "runner-successor",
	channelEpoch: "2",
	hostInstanceId: "host-successor",
	terminalEpoch: "terminal-successor",
};

function designLabsAgent(patch: Partial<Agent> = {}): Agent {
	return managedAgentFixture({
		id: "agent-import",
		name: "design-labs",
		provider: "claude",
		projectId: "project-design-labs",
		worktreePath: "/repo/.worktrees/design-labs",
		branch: "agent/design-labs",
		sessionId: "agent-import",
		conversationId: "conversation-design-labs",
		runtimeBinding: managedBindingFixture({
			sessionId: "agent-import",
			workspaceId: "workspace-design-labs",
			createIdempotencyKey: "agent-import",
			stopFence: sourceFence,
		}),
		...patch,
	});
}

function notRehosted(): HmuxManagedRehostResolution {
	return {
		schema: "hmux-managed-rehost-resolution-v1",
		schemaVersion: 1,
		state: "not_found",
		source: {
			sessionId: "agent-import",
			workspaceId: "workspace-design-labs",
		},
	};
}

function readySession(): HmuxSessionSummary {
	return {
		sessionId: "agent-import",
		workspaceId: "workspace-design-labs",
		sessionClass: "managed",
		lifecycle: "ready",
		manifestLifecycle: "ready",
		health: "current_healthy",
		inputAllowed: true,
		terminalEpoch: sourceFence.terminalEpoch,
		stopFence: sourceFence,
		outputSeq: "7",
		capabilities: [],
	};
}

const request = {
	providerId: "claude" as const,
	conversationId: "conversation-design-labs",
};

beforeEach(() => {
	mocks.resolveSuccessor.mockReset().mockResolvedValue(notRehosted());
	mocks.inspectSession.mockReset().mockResolvedValue(undefined);
	mocks.inspectWriter.mockReset().mockResolvedValue({
		session: readySession(),
		idempotencyKey: "agent-import",
		conversationId: "conversation-design-labs",
		permissionMode: "default",
	});
	useStore.setState({
		agents: [designLabsAgent()],
		projects: [
			{
				id: "project-design-labs",
				name: "HebbianIDE",
				path: "/repo",
				kind: "local",
				isRepo: true,
			},
		],
		skipPermissions: {},
		accounts: [],
	});
});

describe("managed conversation ownership", () => {
	it("returns the retained create and fences other registrations for its continuation", async () => {
		const pending = designLabsAgent({
			started: false,
			runtimeBinding: managedBindingFixture({
				sessionId: "agent-import",
				workspaceId: "workspace-design-labs",
				createIdempotencyKey: "agent-import",
			}),
		});
		useStore.setState({ agents: [pending] });
		const ownership = await resolveManagedConversationOwnership(request);
		expect(ownership).toMatchObject({
			state: "pending",
			agent: pending,
			permit: { candidateFingerprints: [] },
		});
		expect(mocks.inspectSession).not.toHaveBeenCalled();
		expect(mocks.resolveSuccessor).not.toHaveBeenCalled();
		if (ownership.state !== "pending")
			throw new Error("expected retained registration");
		await expect(
			revalidateManagedConversationLaunchPermit(ownership.permit, pending.id),
		).resolves.toBeUndefined();
		useStore.setState({
			agents: [pending, { ...pending, id: "second-pending" }],
		});
		await expect(
			revalidateManagedConversationLaunchPermit(ownership.permit, pending.id),
		).rejects.toThrow("became live before create");
	});
	it("does not choose between two unfinished creates for the same local conversation", async () => {
		const pending = designLabsAgent({
			started: false,
			runtimeBinding: managedBindingFixture({
				sessionId: "agent-import",
				workspaceId: "workspace-design-labs",
				createIdempotencyKey: "agent-import",
			}),
		});
		useStore.setState({
			agents: [pending, { ...pending, id: "second-pending" }],
		});
		await expect(resolveManagedConversationOwnership(request)).rejects.toThrow(
			"multiple exact conversation owners",
		);
	});

	it.each([undefined, "conversation-stale"])(
		"keeps Host-owned conversation %s active instead of granting a vacant permit",
		async (topLevelConversationId) => {
			const binding = managedBindingFixture({
				sessionId: "agent-import",
				workspaceId: "workspace-design-labs",
				createIdempotencyKey: "agent-import",
				stopFence: sourceFence,
				conversationIdentity: {
					schemaVersion: 1,
					sessionId: "agent-import",
					workspaceId: "workspace-design-labs",
					...sourceFence,
					revision: "3",
					observedThroughOutputSeq: "9",
					providerId: "claude",
					conversationId: request.conversationId,
					source: "provider_event",
				},
			});
			useStore.setState({
				agents: [
					designLabsAgent({
						conversationId: topLevelConversationId,
						runtimeBinding: binding,
					}),
				],
			});
			mocks.inspectSession.mockResolvedValueOnce(readySession());

			const result = await resolveManagedConversationOwnership(request);

			expect(result).toMatchObject({
				state: "active",
				agent: { id: "agent-import" },
			});
			expect(mocks.inspectWriter).toHaveBeenCalledWith(
				expect.objectContaining({ conversationId: request.conversationId }),
			);
		},
	);

	it("grants a launch permit only after exact source and successor absence", async () => {
		const result = await resolveManagedConversationOwnership(request);

		expect(result).toMatchObject({
			state: "vacant",
			permit: {
				providerId: "claude",
				conversationId: "conversation-design-labs",
			},
		});
		expect(mocks.resolveSuccessor).toHaveBeenCalledWith(
			"agent-import",
			"workspace-design-labs",
		);
		expect(mocks.inspectSession).toHaveBeenCalledWith({
			sessionId: "agent-import",
			workspaceId: "workspace-design-labs",
		});
		expect(mocks.inspectWriter).not.toHaveBeenCalled();
	});

	it("returns the exact owner only after its current Host writer is verified", async () => {
		mocks.inspectSession.mockResolvedValueOnce(readySession());

		const result = await resolveManagedConversationOwnership(request);

		expect(result).toMatchObject({
			state: "active",
			agent: { id: "agent-import" },
		});
		expect(mocks.inspectWriter).toHaveBeenCalledWith({
			sessionId: "agent-import",
			workspaceId: "workspace-design-labs",
			providerId: "claude",
			conversationId: "conversation-design-labs",
			cwd: "/repo/.worktrees/design-labs",
			permissionMode: "default",
			launchReference: undefined,
		});
	});

	it("never treats an opaque Hmux launch reference as an Agent credential", async () => {
		const credentialId = "account-a";
		useStore.setState({
			agents: [
				designLabsAgent({
					credentialId,
					runtimeBinding: managedBindingFixture({
						sessionId: "agent-import",
						workspaceId: "workspace-design-labs",
						createIdempotencyKey: "agent-import",
						credentialId,
						stopFence: sourceFence,
					}),
				}),
			],
		});
		mocks.inspectSession.mockResolvedValueOnce(readySession());
		mocks.inspectWriter.mockResolvedValueOnce({
			session: readySession(),
			idempotencyKey: "agent-import",
			conversationId: "conversation-design-labs",
			launchReference: "opaque+provider-reference",
			permissionMode: "default",
		});

		await expect(resolveManagedConversationOwnership(request)).rejects.toThrow(
			"changed generation",
		);
		expect(mocks.inspectWriter).toHaveBeenCalledWith(
			expect.objectContaining({ launchReference: credentialId }),
		);
	});

	it("refuses a vacant permit when the exact owner becomes live before create", async () => {
		const initial = await resolveManagedConversationOwnership(request);
		if (initial.state !== "vacant") throw new Error("expected vacant permit");
		mocks.inspectSession.mockResolvedValue(readySession());

		await expect(
			revalidateManagedConversationLaunchPermit(
				initial.permit,
				"agent-transaction",
			),
		).rejects.toThrow("became live before create");
	});

	it("fails closed when exact discovery cannot establish absence", async () => {
		mocks.inspectSession.mockRejectedValueOnce(
			new Error("hmux_exact_inspection_unprobed"),
		);

		await expect(resolveManagedConversationOwnership(request)).rejects.toThrow(
			"hmux_exact_inspection_unprobed",
		);
		expect(mocks.inspectWriter).not.toHaveBeenCalled();
	});

	it("excludes matching SSH conversations from local ownership", async () => {
		useStore.setState({
			agents: [
				designLabsAgent({
					runtimeBinding: {
						schemaVersion: 1,
						runtime: "hmux_managed_v1",
						source: "ssh",
						hostId: "remote-host",
						sessionId: "agent-remote",
						workspaceId: "workspace-remote",
						createIdempotencyKey: "agent-remote",
						commandBridgeNonce: "bridge-remote",
					},
				}),
			],
		});

		await expect(
			resolveManagedConversationOwnership(request),
		).resolves.toMatchObject({
			state: "vacant",
			permit: { candidateFingerprints: [] },
		});
		expect(mocks.resolveSuccessor).not.toHaveBeenCalled();
		expect(mocks.inspectSession).not.toHaveBeenCalled();
	});

	it("does not create beside a durable successor mapping", async () => {
		const resolution: HmuxManagedRehostResolution = {
			schema: "hmux-managed-rehost-resolution-v1",
			schemaVersion: 1,
			state: "resolved",
			operationIds: ["rehost-1"],
			sourceGeneration: {
				sessionId: "agent-import",
				workspaceId: "workspace-design-labs",
				...sourceFence,
			},
			currentGeneration: {
				sessionId: "agent-successor",
				workspaceId: "workspace-design-labs",
				...successorFence,
			},
			providerId: "claude",
			permissionMode: "default",
		};
		mocks.resolveSuccessor.mockResolvedValueOnce(resolution);

		await expect(
			resolveManagedConversationOwnership(request),
		).rejects.toBeInstanceOf(ManagedConversationOwnershipUnavailableError);
		expect(mocks.inspectSession).not.toHaveBeenCalled();
		expect(mocks.inspectWriter).not.toHaveBeenCalled();
	});

	it("rejects a successor that appears during the exact absence inspection", async () => {
		const resolution: HmuxManagedRehostResolution = {
			schema: "hmux-managed-rehost-resolution-v1",
			schemaVersion: 1,
			state: "resolved",
			operationIds: ["rehost-race"],
			sourceGeneration: {
				sessionId: "agent-import",
				workspaceId: "workspace-design-labs",
				...sourceFence,
			},
			currentGeneration: {
				sessionId: "agent-successor",
				workspaceId: "workspace-design-labs",
				...successorFence,
			},
			providerId: "claude",
			permissionMode: "default",
		};
		mocks.resolveSuccessor
			.mockResolvedValueOnce(notRehosted())
			.mockResolvedValueOnce(resolution);

		await expect(resolveManagedConversationOwnership(request)).rejects.toThrow(
			"durable successor",
		);
		expect(mocks.inspectSession).toHaveBeenCalledOnce();
	});

	it("rejects a registry identity that changes while Hmux absence is inspected", async () => {
		mocks.inspectSession.mockImplementationOnce(async () => {
			useStore.setState({
				agents: [designLabsAgent({ worktreePath: "/repo/changed" })],
			});
			return undefined;
		});

		await expect(resolveManagedConversationOwnership(request)).rejects.toThrow(
			"owner registrations changed",
		);
	});

	it("rejects an exact session whose live generation does not match the binding", async () => {
		mocks.inspectSession.mockResolvedValueOnce(readySession());
		mocks.inspectWriter.mockResolvedValueOnce({
			session: {
				...readySession(),
				terminalEpoch: "terminal-reused",
				stopFence: { ...sourceFence, terminalEpoch: "terminal-reused" },
			},
			idempotencyKey: "agent-import",
			conversationId: "conversation-design-labs",
			permissionMode: "default",
		});

		await expect(resolveManagedConversationOwnership(request)).rejects.toThrow(
			"changed generation",
		);
	});
});
