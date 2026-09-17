import { describe, expect, it } from "vitest";
import { managedAgentBuildRehostSource } from "@/lib/sessions/managed/managedBuildRehostAuthority";
import { managedAgentFixture } from "@/test/agentFixtures";

describe("managed build rehost authority", () => {
	it("routes Native managed Agents through rehost regardless of backend ownership", () => {
		const native = managedAgentFixture({ id: "native-agent" });
		expect(managedAgentBuildRehostSource(native)).toBe("native-agent");
		expect(
			managedAgentBuildRehostSource({
				...native,
				executionProfile: { kind: "provider_default" },
			}),
		).toBe("native-agent");
		expect(
			managedAgentBuildRehostSource({
				...native,
				interactionProfile: {
					schemaVersion: 1,
					kind: "structured_protocol",
					backendProfileId: "local",
					interactionSessionId: "interaction-1",
				},
			}),
		).toBeUndefined();
	});
});
