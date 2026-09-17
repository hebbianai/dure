import { describe, expect, it } from "vitest";
import { agentRuntimePresentationOwnerKey } from "@/lib/agents/agentRuntimePresentationOwner";
import {
	agentFixture,
	managedBindingFixture,
	stopFenceFixture,
} from "@/test/agentFixtures";

describe("agentRuntimePresentationOwnerKey", () => {
	it("tracks the exact native runtime and canonical execution profile", () => {
		const binding = managedBindingFixture({
			sessionId: "session-1",
			workspaceId: "workspace-1",
			createIdempotencyKey: "create-1",
			backendProfileId: "local",
			stopFence: stopFenceFixture(),
		});
		const source = agentFixture({
			id: "agent-1",
			sessionId: binding.sessionId,
			runtimeBinding: binding,
		});
		const sourceKey = agentRuntimePresentationOwnerKey(source);

		expect(
			agentRuntimePresentationOwnerKey({
				...source,
				credentialId: "account-b",
				runtimeBinding: { ...binding, credentialId: "account-b" },
			}),
		).toBe(sourceKey);
		expect(
			agentRuntimePresentationOwnerKey({
				...source,
				executionProfile: {
					kind: "credential_reference",
					reference_id: "account-b",
					credential_generation: "credential-b-1",
				},
			}),
		).not.toBe(sourceKey);
		expect(
			agentRuntimePresentationOwnerKey({
				...source,
				sessionId: "session-2",
				runtimeBinding: { ...binding, sessionId: "session-2" },
			}),
		).not.toBe(sourceKey);
		expect(
			agentRuntimePresentationOwnerKey({
				...source,
				runtimeBinding: {
					...binding,
					stopFence: { ...binding.stopFence!, terminalEpoch: "terminal-2" },
				},
			}),
		).not.toBe(sourceKey);
	});

	it("tracks structured credential replacement within one interaction", () => {
		const source = agentFixture({
			id: "agent-structured",
			runtimeBinding: undefined,
			interactionProfile: {
				schemaVersion: 1,
				kind: "structured_protocol",
				backendProfileId: "local",
				interactionSessionId: "interaction-1",
			},
			executionProfile: {
				kind: "credential_reference",
				reference_id: "account-a",
				credential_generation: "credential-a-1",
			},
		});
		const sourceKey = agentRuntimePresentationOwnerKey(source);

		expect(
			agentRuntimePresentationOwnerKey({
				...source,
				interactionProfile: {
					...source.interactionProfile!,
					interactionSessionId: "interaction-2",
				},
			}),
		).not.toBe(sourceKey);
		expect(
			agentRuntimePresentationOwnerKey({
				...source,
				interactionProfile: {
					...source.interactionProfile!,
					backendProfileId: "remote",
				},
			}),
		).not.toBe(sourceKey);
		expect(
			agentRuntimePresentationOwnerKey({
				...source,
				executionProfile: {
					kind: "credential_reference",
					reference_id: "account-b",
					credential_generation: "credential-b-2",
				},
			}),
		).not.toBe(sourceKey);
		expect(
			agentRuntimePresentationOwnerKey({
				...source,
				executionProfile: { kind: "provider_default" },
			}),
		).not.toBe(sourceKey);
	});
});
