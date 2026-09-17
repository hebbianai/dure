import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	loadDetails: vi.fn(),
}));

vi.mock("@/lib/agents/providerConversationDiscovery", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@/lib/agents/providerConversationDiscovery")
	>()),
	loadProviderConversationDetails: mocks.loadDetails,
}));

import {
	providerConversationDetailsTarget,
	providerConversationInputAuthority,
	requireIndependentProviderConversationInput,
} from "@/lib/agents/providerConversationInputAuthority";
import { managedAgentFixture } from "@/test/agentFixtures";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("provider conversation input authority", () => {
	it("normalizes only a complete provider-neutral authority projection", () => {
		expect(providerConversationInputAuthority({ kind: "independent" })).toEqual({
			kind: "independent",
		});
		expect(
			providerConversationInputAuthority({
				kind: "controlled_by_parent",
				parentConversationId: "parent-1",
			}),
		).toEqual({
			kind: "controlled_by_parent",
			parentConversationId: "parent-1",
		});
		expect(
			providerConversationInputAuthority({
				kind: "controlled_by_parent",
				parentConversationId: "",
			}),
		).toEqual({ kind: "unverified" });
		expect(providerConversationInputAuthority(undefined)).toEqual({
			kind: "unverified",
		});
	});

	it("derives one exact local or remote adapter target without provider branches", () => {
		const local = managedAgentFixture({
			provider: "codex",
			conversationId: "conversation-local",
		});
		expect(providerConversationDetailsTarget(local, [])).toEqual({
			provider: "codex",
			conversationId: "conversation-local",
			executionLocation: "local",
		});
		const remote = {
			...local,
			sessionKind: "ssh" as const,
			runtimeBinding: {
				schemaVersion: 1 as const,
				runtime: "hmux_managed_v1" as const,
				source: "ssh" as const,
				hostId: "host-1",
				sessionId: "session-remote",
				workspaceId: "workspace-1",
				createIdempotencyKey: "create-remote",
				commandBridgeNonce: "bridge-1",
			},
		};
		expect(providerConversationDetailsTarget(remote, [])).toEqual({
			provider: "codex",
			conversationId: "conversation-local",
			executionLocation: "ssh",
			hostId: "host-1",
		});
	});

	it("returns a typed refusal before admission for a parent-controlled conversation", async () => {
		mocks.loadDetails.mockResolvedValue({
			inputAuthority: {
				kind: "controlled_by_parent",
				parentConversationId: "parent-1",
			},
			subagents: [],
			totalCount: 0,
		});
		const target = {
			provider: "codex" as const,
			conversationId: "child-1",
			executionLocation: "local" as const,
		};

		await expect(
			requireIndependentProviderConversationInput(target, []),
		).rejects.toMatchObject({
			name: "ProviderConversationInputAuthorityError",
			code: "provider_conversation_controlled_by_parent",
			conversationId: "child-1",
			parentConversationId: "parent-1",
		});
	});

	it("fails closed when an older adapter omits the authority field", async () => {
		mocks.loadDetails.mockResolvedValue({ subagents: [], totalCount: 0 });

		await expect(
			requireIndependentProviderConversationInput(
				{
					provider: "codex",
					conversationId: "conversation-1",
					executionLocation: "local",
				},
				[],
			),
		).rejects.toMatchObject({
			code: "provider_conversation_input_authority_unverified",
		});
	});
});
