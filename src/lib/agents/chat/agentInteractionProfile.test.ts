import { describe, expect, it } from "vitest";
import { normalizeAgentInteractionProfileV1 } from "@/lib/agents/chat/agentInteractionProfile";

describe("normalizeAgentInteractionProfileV1", () => {
	it("keeps only the backend profile and durable interaction identity", () => {
		expect(
			normalizeAgentInteractionProfileV1({
				schemaVersion: 1,
				kind: "structured_protocol",
				backendProfileId: "local",
				interactionSessionId: "interaction-1",
			}),
		).toEqual({
			schemaVersion: 1,
			kind: "structured_protocol",
			backendProfileId: "local",
			interactionSessionId: "interaction-1",
		});
		expect(
			normalizeAgentInteractionProfileV1({
				schemaVersion: 1,
				kind: "structured_protocol",
				backendProfileId: "local",
				interactionSessionId: "interaction-1",
				runtimeGeneration: "client-must-not-own-this",
			}),
		).toBeUndefined();
	});
});
