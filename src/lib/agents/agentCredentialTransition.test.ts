import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	structured: true,
	switchRuntime: vi.fn(),
	switchManaged: vi.fn(),
	scheduleBusy: vi.fn(),
}));

vi.mock("@/lib/agents/providers", () => ({
	supportsStructuredChat: () => mocks.structured,
}));
vi.mock("@/lib/agents/agentRuntimeTransitionAction", () => ({
	switchAgentRuntimeCredential: mocks.switchRuntime,
}));
vi.mock("@/lib/sessions/credentials/deferredCredentialSwitchRuntime", () => ({
	requestManagedCredentialSwitch: mocks.switchManaged,
	scheduleBusyAgentCredentialSwitch: mocks.scheduleBusy,
}));

import { requestAgentCredentialTransition } from "@/lib/agents/agentCredentialTransition";
import { DureAgentRuntimeSourceActiveError } from "@/lib/ipc/dureAgentRuntime";
import { DureBackendRequestError } from "@/lib/ipc/dureBackend";
import { getManagedCredentialSwitchTransition } from "@/lib/sessions/managed/managedCredentialSwitchTransition";
import { useStore } from "@/store";
import { agentFixture, managedBindingFixture } from "@/test/agentFixtures";

const agent = agentFixture({
	id: "agent-1",
	provider: "codex",
	runtimeBinding: managedBindingFixture(),
});

beforeEach(() => {
	mocks.structured = true;
	mocks.switchRuntime.mockReset().mockResolvedValue({
		providerConversationRef: "conversation-next",
	});
	mocks.switchManaged.mockReset().mockResolvedValue({
		kind: "scheduled",
		conversationId: "conversation-current",
	});
	mocks.scheduleBusy.mockReset().mockResolvedValue({
		kind: "scheduled",
		conversationId: "conversation-current",
	});
	useStore.setState({ agents: [agent] });
});

describe("requestAgentCredentialTransition", () => {
	it.each([false, true])(
		"publishes progress before preparation and clears it on failure=%s",
		async (fails) => {
			mocks.switchRuntime.mockImplementationOnce(async () => {
				expect(getManagedCredentialSwitchTransition(agent.id)).toBe(true);
				if (fails) throw new Error("preparation failed");
				return { providerConversationRef: "conversation-next" };
			});
			const request = requestAgentCredentialTransition({
				agentId: agent.id,
				targetCredentialId: "account-2",
				sourcePanelId: `agent:${agent.id}`,
			});
			if (fails) await expect(request).rejects.toThrow("preparation failed");
			else await expect(request).resolves.toMatchObject({ kind: "completed" });
			expect(getManagedCredentialSwitchTransition(agent.id)).toBe(false);
		},
	);

	it("uses the revisioned runtime action for a structured provider", async () => {
		await expect(
			requestAgentCredentialTransition({
				agentId: agent.id,
				targetCredentialId: "account-2",
				sourcePanelId: `agent:${agent.id}`,
			}),
		).resolves.toEqual({
			kind: "completed",
			conversationId: "conversation-next",
			runtime: { providerConversationRef: "conversation-next" },
		});
		expect(mocks.switchRuntime).toHaveBeenCalledWith(agent.id, "account-2");
		expect(mocks.switchManaged).not.toHaveBeenCalled();
	});

	it("lets the revisioned action recover a route-less structured Agent", async () => {
		useStore.setState({
			agents: [agentFixture({ id: agent.id, provider: "codex" })],
		});

		await expect(
			requestAgentCredentialTransition({
				agentId: agent.id,
				targetCredentialId: "account-2",
				sourcePanelId: `agent:${agent.id}`,
			}),
		).resolves.toEqual({
			kind: "completed",
			conversationId: "conversation-next",
			runtime: { providerConversationRef: "conversation-next" },
		});
		expect(mocks.switchRuntime).toHaveBeenCalledWith(agent.id, "account-2");
	});

	it.each(["claude", "codex"] as const)(
		"uses the owning native SSH runtime for route-less %s",
		async (provider) => {
			useStore.setState({
				agents: [
					agentFixture({
						id: agent.id,
						provider,
						runtimeBinding: {
							...managedBindingFixture(),
							source: "ssh",
							hostId: "host-1",
							commandBridgeNonce: "bridge-1",
							createIdempotencyKey: "create-1",
						},
					}),
				],
			});
			await requestAgentCredentialTransition({
				agentId: agent.id,
				targetCredentialId: "account-2",
				sourcePanelId: `agent:${agent.id}`,
			});
			expect(mocks.switchManaged).toHaveBeenCalledWith(
				agent.id,
				"account-2",
				`agent:${agent.id}`,
			);
			expect(mocks.switchRuntime).not.toHaveBeenCalled();
		},
	);

	it.each([
		undefined,
		{
			schemaVersion: 1,
			kind: "structured_protocol",
			backendProfileId: "remote-1",
			interactionSessionId: "interaction-1",
		},
	] as const)(
		"keeps routed SSH %s on the backend action",
		async (interactionProfile) => {
			useStore.setState({
				agents: [
					agentFixture({
						id: agent.id,
						provider: "claude",
						interactionProfile,
						runtimeBinding: {
							...managedBindingFixture(),
							source: "ssh",
							hostId: "host-1",
							commandBridgeNonce: "bridge-1",
							createIdempotencyKey: "create-1",
							backendProfileId: "remote-1",
						},
					}),
				],
			});
			await requestAgentCredentialTransition({
				agentId: agent.id,
				targetCredentialId: "account-2",
				sourcePanelId: `agent:${agent.id}`,
			});
			expect(mocks.switchRuntime).toHaveBeenCalledWith(agent.id, "account-2");
			expect(mocks.switchManaged).not.toHaveBeenCalled();
		},
	);

	it("queues an active source without authorizing interruption", async () => {
		const refusal = new DureAgentRuntimeSourceActiveError(
			new DureBackendRequestError("agent_runtime_source_busy", "busy", {
				schemaVersion: 1,
				kind: "invalid",
				code: "agent_runtime_source_busy",
				message: "busy",
			} as never),
			7,
		);
		mocks.switchRuntime.mockRejectedValueOnce(refusal);

		await expect(
			requestAgentCredentialTransition({
				agentId: agent.id,
				targetCredentialId: "account-2",
				sourcePanelId: `agent:${agent.id}`,
			}),
		).resolves.toEqual({
			kind: "scheduled",
			conversationId: "conversation-current",
		});
		expect(mocks.switchRuntime).toHaveBeenCalledExactlyOnceWith(
			agent.id,
			"account-2",
		);
		expect(mocks.scheduleBusy).toHaveBeenCalledWith(
			agent.id,
			"account-2",
			`agent:${agent.id}`,
			7,
		);
		expect(mocks.switchManaged).not.toHaveBeenCalled();
	});

	it("keeps the reviewed managed replacement adapter for other providers", async () => {
		mocks.structured = false;

		await expect(
			requestAgentCredentialTransition({
				agentId: agent.id,
				targetCredentialId: null,
				sourcePanelId: `agent:${agent.id}`,
			}),
		).resolves.toEqual({
			kind: "scheduled",
			conversationId: "conversation-current",
		});
		expect(mocks.switchManaged).toHaveBeenCalledWith(
			agent.id,
			null,
			`agent:${agent.id}`,
		);
		expect(mocks.switchRuntime).not.toHaveBeenCalled();
	});

	it("delegates a stale pending projection to backend runtime authority", async () => {
		useStore.setState({
			agents: [
				{
					...agent,
					pendingCredentialSwitch: {
						targetCredentialId: "account-pending",
					} as NonNullable<typeof agent.pendingCredentialSwitch>,
				},
			],
		});

		await expect(
			requestAgentCredentialTransition({
				agentId: agent.id,
				targetCredentialId: "account-2",
				sourcePanelId: `agent:${agent.id}`,
			}),
		).resolves.toEqual({
			kind: "completed",
			conversationId: "conversation-next",
			runtime: { providerConversationRef: "conversation-next" },
		});
		expect(mocks.switchRuntime).toHaveBeenCalledWith(agent.id, "account-2");
		expect(mocks.switchManaged).not.toHaveBeenCalled();
	});
});

describe("busy source without queue authority", () => {
	it.each([undefined, 7])(
		"never falls back to discard for source revision %s",
		async (revision) => {
			const refusal = new DureAgentRuntimeSourceActiveError(
				new DureBackendRequestError(
					"agent_runtime_source_busy",
					"busy",
					{} as never,
				),
				revision,
			);
			mocks.switchRuntime.mockRejectedValueOnce(refusal);
			mocks.scheduleBusy.mockResolvedValueOnce(null);
			await expect(
				requestAgentCredentialTransition({
					agentId: agent.id,
					targetCredentialId: "account-2",
					sourcePanelId: `agent:${agent.id}`,
				}),
			).rejects.toBe(refusal);
			expect(mocks.switchRuntime).toHaveBeenCalledTimes(1);
			expect(mocks.switchManaged).not.toHaveBeenCalled();
		},
	);
});
