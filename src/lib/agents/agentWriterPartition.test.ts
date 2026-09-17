import { describe, expect, it } from "vitest";
import {
	CanonicalAgentLegacyWriterRefusedError,
	isLegacyAgentWriterTarget,
	requireLegacyAgentWriterTarget,
} from "@/lib/agents/agentWriterPartition";
import { agentFixture } from "@/test/agentFixtures";

describe("Agent writer partition", () => {
	it("admits legacy projections and refuses canonical projections", () => {
		const legacy = agentFixture();
		const canonical = {
			...legacy,
			canonicalSpawn: {
				schemaVersion: 1 as const,
				backendProfileId: "local",
				operationId: "spawn-canonical",
			},
		};

		expect(isLegacyAgentWriterTarget(legacy)).toBe(true);
		expect(requireLegacyAgentWriterTarget(legacy)).toBe(legacy);
		expect(isLegacyAgentWriterTarget(canonical)).toBe(false);
		expect(() => requireLegacyAgentWriterTarget(canonical)).toThrow(
			CanonicalAgentLegacyWriterRefusedError,
		);
	});
});
