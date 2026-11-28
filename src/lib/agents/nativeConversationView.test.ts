import { describe, expect, it } from "vitest";
import { nativeConversationRecord } from "@/lib/agents/nativeConversationView";
import type { HmuxAgentRuntimeState } from "@/lib/ipc";
import {
	managedAgentFixture,
	managedBindingFixture,
	stopFenceFixture,
} from "@/test/agentFixtures";
import type { Agent } from "@/types";

const identity = {
	...stopFenceFixture({ terminalEpoch: "epoch-1" }),
	schemaVersion: 1 as const,
	sessionId: "session-1",
	workspaceId: "workspace-1",
	revision: "1",
	observedThroughOutputSeq: "1",
	source: "provider_event" as const,
	providerId: "codex" as const,
	conversationId: "conversation-1",
};

const recorded = managedAgentFixture({
	runtimeBinding: managedBindingFixture({ conversationIdentity: identity }),
});

const running: HmuxAgentRuntimeState = {
	terminalEpoch: "epoch-1",
	revision: "1",
	observedThroughOutputSeq: "1",
	source: "provider_event",
	lifecycle: "running",
	activity: "waiting",
	attention: "none",
	turnCompletedCount: "3",
};

const source = (conversationId: string) => ({
	kind: "local",
	agentId: "agent-1",
	provider: "codex",
	conversationId,
});

describe("nativeConversationRecord", () => {
	it("is the live conversation, with its runtime, while the pane could show it", () => {
		expect(nativeConversationRecord(recorded, running, "working")).toEqual({
			source: source("conversation-1"),
			terminalEpoch: "epoch-1",
			turnCompletedCount: "3",
			working: true,
			runtime: running,
		});
	});

	it("is the last recorded conversation, read only, once the session has ended", () => {
		// Nothing reads it again: no count, never working.
		const ended = {
			source: source("conversation-1"),
			terminalEpoch: "epoch-1",
			turnCompletedCount: undefined,
			working: false,
		};
		// Gone from the Host, or still there as an exited generation.
		expect(nativeConversationRecord(recorded, undefined, "exited")).toEqual(
			ended,
		);
		expect(
			nativeConversationRecord(
				recorded,
				{ ...running, lifecycle: "exited" },
				"exited",
			),
		).toEqual(ended);
	});

	it("is nothing while the session's state is unknown or not yet this conversation's", () => {
		expect(nativeConversationRecord(recorded, undefined, "unknown")).toBe(
			undefined,
		);
		expect(
			nativeConversationRecord(
				recorded,
				{ ...running, terminalEpoch: "epoch-2" },
				"waiting",
			),
		).toBe(undefined);
	});

	it("reads an ended Agent's own recorded id only when its binding records none", () => {
		const unbound = (patch: Partial<Agent>) =>
			managedAgentFixture({ conversationId: "conversation-0", ...patch });
		expect(nativeConversationRecord(unbound({}), undefined, "exited")).toEqual({
			source: source("conversation-0"),
			terminalEpoch: "ended",
			turnCompletedCount: undefined,
			working: false,
		});
		// Never for a live session, and never past a record for another
		// provider.
		expect(nativeConversationRecord(unbound({}), running, "waiting")).toBe(
			undefined,
		);
		expect(
			nativeConversationRecord(
				unbound({
					runtimeBinding: managedBindingFixture({
						conversationIdentity: { ...identity, providerId: "claude" },
					}),
				}),
				undefined,
				"exited",
			),
		).toBe(undefined);
	});

	it("is nothing for a remote, standalone or unsupported terminal", () => {
		const others: Agent[] = [
			{ ...recorded, provider: "opencode" },
			{
				...recorded,
				sessionKind: "ssh",
				runtimeBinding: {
					...identity,
					schemaVersion: 1,
					runtime: "hmux_managed_v1",
					source: "ssh",
					hostId: "host-1",
					createIdempotencyKey: "create-1",
					commandBridgeNonce: "bridge-1",
					conversationIdentity: identity,
				},
			},
			{
				...recorded,
				runtimeBinding: {
					schemaVersion: 1,
					runtime: "hmux_standalone_v1",
					source: "local",
					hostId: "local",
					sessionId: "session-1",
					workspaceId: "workspace-1",
				},
				conversationId: "conversation-1",
			},
		];
		for (const agent of others) {
			expect(nativeConversationRecord(agent, undefined, "exited")).toBe(
				undefined,
			);
		}
	});
});
