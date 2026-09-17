import { describe, expect, it } from "vitest";
import { managedAgentRehostDisposition } from "@/lib/sessions/managed/managedAgentRehostDisposition";

function inspection(
	sourceLifecycle: "ready" | "exited" | "unavailable",
	sourceBuildId: string,
	targetBuildId?: string,
) {
	return {
		sourceLifecycle,
		plan: { sourceBuildId, targetBuildId },
	};
}

describe("managed agent rehost disposition", () => {
	it("makes an exact ready same-build inspection idempotent", () => {
		expect(
			managedAgentRehostDisposition(
				inspection("ready", " build-current ", "build-current"),
			),
		).toBe("already_current");
	});

	it.each([
		["older build", inspection("ready", "build-old", "build-current")],
		["unavailable same build", inspection("unavailable", "same", "same")],
		["exited same build", inspection("exited", "same", "same")],
		["unknown target", inspection("ready", "build-current")],
	] as const)("requires rehost for %s", (_name, candidate) => {
		expect(managedAgentRehostDisposition(candidate)).toBe("rehost_required");
	});
});
