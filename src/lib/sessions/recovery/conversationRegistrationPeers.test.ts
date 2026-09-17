import { describe, expect, it } from "vitest";
import {
	managedAgentFixture,
	managedBindingFixture,
	stopFenceFixture,
} from "@/test/agentFixtures";
import type { Agent } from "@/types";
import { conversationRegistrationPeers } from "./conversationRegistrationPeers";

const source = managedAgentFixture({ conversationId: "shared-conversation" });
const peer = managedAgentFixture({
	id: "peer",
	conversationId: "shared-conversation",
	sessionId: "peer-session",
	runtimeBinding: managedBindingFixture({ sessionId: "peer-session" }),
});

describe("saved conversation registration peers", () => {
	it("finds separate sessions across worktrees without changing saved records", () => {
		const records = [source, { ...peer, worktreePath: "/another-worktree" }];
		expect(conversationRegistrationPeers(records, source.id)).toEqual([
			records[1],
		]);
		expect(records[0]).toBe(source);
	});

	it.each([
		{ ...peer, provider: "claude" as const },
		{ ...peer, conversationId: "other" },
		{ ...peer, conversationId: undefined },
		{ ...peer, id: source.id },
		{ ...peer, runtimeBinding: source.runtimeBinding },
		{ ...peer, runtimeBinding: undefined },
		{
			...peer,
			runtimeBinding: managedBindingFixture({
				sessionId: "peer-session",
				backendProfileId: "another-backend",
			}),
		},
		{
			...peer,
			runtimeBinding: {
				...managedBindingFixture({ sessionId: "peer-session" }),
				source: "ssh" as const,
				hostId: "remote",
				createIdempotencyKey: "remote-create",
				commandBridgeNonce: "remote-bridge",
			},
		},
		{
			...peer,
			interactionProfile: {
				schemaVersion: 1 as const,
				kind: "structured_protocol" as const,
				backendProfileId: "backend",
				interactionSessionId: "chat",
			},
		},
	])(
		"does not conflate another namespace or a shared session view (%#)",
		(other: Agent) => {
			expect(conversationRegistrationPeers([source, other], source.id)).toEqual(
				[],
			);
		},
	);

	it("uses a Host-projected fork child instead of the legacy source ID", () => {
		const fork = {
			...peer,
			runtimeBinding: managedBindingFixture({
				sessionId: "peer-session",
				conversationIdentity: {
					schemaVersion: 1,
					...stopFenceFixture(),
					sessionId: "peer-session",
					workspaceId: "workspace-1",
					providerId: "codex",
					conversationId: "fork-child",
					revision: "1",
					observedThroughOutputSeq: "2",
					source: "provider_event",
				},
			}),
		};
		expect(conversationRegistrationPeers([source, fork], source.id)).toEqual(
			[],
		);
	});

	it("has no candidate group without a concrete local managed source conversation", () => {
		expect(conversationRegistrationPeers([peer], source.id)).toEqual([]);
		expect(
			conversationRegistrationPeers(
				[{ ...source, conversationId: " " }, peer],
				source.id,
			),
		).toEqual([]);
		expect(
			conversationRegistrationPeers(
				[{ ...source, runtimeBinding: undefined }, peer],
				source.id,
			),
		).toEqual([]);
	});
});
