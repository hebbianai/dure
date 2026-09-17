import { describe, expect, it } from "vitest";
import {
	parseAgentCanonicalSpawnV1,
	sameAgentCanonicalSpawn,
} from "@/lib/agents/agentCanonicalSpawn";

const canonical = {
	schemaVersion: 1 as const,
	backendProfileId: "local",
	operationId: "spawn-123",
};

describe("Agent canonical spawn projection", () => {
	it("parses one strict versioned receipt identity", () => {
		expect(parseAgentCanonicalSpawnV1(canonical)).toEqual(canonical);
		expect(
			parseAgentCanonicalSpawnV1({ ...canonical, backendGeneration: "old" }),
		).toBeUndefined();
		expect(
			parseAgentCanonicalSpawnV1({
				...canonical,
				operationId: "bad operation",
			}),
		).toBeUndefined();
	});

	it("matches only the same backend profile and spawn operation", () => {
		expect(sameAgentCanonicalSpawn(canonical, { ...canonical })).toBe(true);
		expect(
			sameAgentCanonicalSpawn(canonical, {
				...canonical,
				operationId: "spawn-successor",
			}),
		).toBe(false);
		expect(
			sameAgentCanonicalSpawn(canonical, {
				...canonical,
				backendProfileId: "remote-a",
			}),
		).toBe(false);
		expect(sameAgentCanonicalSpawn(canonical, undefined)).toBe(false);
		expect(sameAgentCanonicalSpawn(undefined, undefined)).toBe(false);
	});
});
