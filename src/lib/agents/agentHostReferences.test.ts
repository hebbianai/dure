import { describe, expect, it } from "vitest";
import { agentHostReferenceIds } from "@/lib/agents/agentHostReferences";
import { agentFixture } from "@/test/agentFixtures";

describe("Agent Host references", () => {
	it("collects only a typed SSH runtime Host authority", () => {
		const agent = agentFixture({
			canonicalSpawn: {
				schemaVersion: 1,
				backendProfileId: "canonical-host",
				operationId: "operation-1",
			},
			runtimeBinding: {
				schemaVersion: 1,
				runtime: "hmux_managed_v1",
				source: "ssh",
				hostId: "runtime-host",
				backendProfileId: "runtime-backend",
				sessionId: "session-1",
				workspaceId: "workspace-1",
				createIdempotencyKey: "create-1",
				commandBridgeNonce: "nonce-1",
			},
			interactionProfile: {
				schemaVersion: 1,
				kind: "structured_protocol",
				backendProfileId: "interaction-host",
				interactionSessionId: "interaction-1",
			},
		});

		expect([...agentHostReferenceIds(agent)]).toEqual(["runtime-host"]);
	});

	it("does not conflate backend profile and SSH Host namespaces", () => {
		const agent = agentFixture({
			canonicalSpawn: {
				schemaVersion: 1,
				backendProfileId: "host-1",
				operationId: "operation-1",
			},
			runtimeBinding: {
				schemaVersion: 1,
				runtime: "hmux_managed_v1",
				source: "local",
				hostId: "local",
				backendProfileId: "host-1",
				sessionId: "session-1",
				workspaceId: "workspace-1",
				createIdempotencyKey: "create-1",
			},
			interactionProfile: {
				schemaVersion: 1,
				kind: "structured_protocol",
				backendProfileId: "host-1",
				interactionSessionId: "interaction-1",
			},
		});

		expect([...agentHostReferenceIds(agent)]).toEqual([]);
	});
});
