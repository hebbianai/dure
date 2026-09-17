import { describe, expect, it } from "vitest";
import {
	type AgentRuntimeLaunchPresentation,
	projectAgentRuntimeLaunchPresentation,
} from "@/lib/agents/agentRuntimeLaunchPresentation";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";

const routeA = testDureBackendRouteAuthority("backend-a", "generation-a");
const routeB = testDureBackendRouteAuthority("backend-b", "generation-b");

function presentation(
	selectionRevision: number,
	model: string,
	ownerKey = "owner-current",
	routeAuthority = routeA,
): AgentRuntimeLaunchPresentation {
	return {
		ownerKey,
		routeAuthority,
		selectionRevision,
		launchSelection: {
			model,
			effort: "high",
			permissionMode: "default",
		},
	};
}

describe("projectAgentRuntimeLaunchPresentation", () => {
	it("replaces an older complete snapshot", () => {
		expect(
			projectAgentRuntimeLaunchPresentation(
				presentation(2, "old"),
				presentation(3, "new"),
			).launchSelection.model,
		).toBe("new");
	});

	it("does not let an older response overwrite the same backend route", () => {
		const newest = presentation(3, "new");
		expect(
			projectAgentRuntimeLaunchPresentation(newest, presentation(2, "old")),
		).toBe(newest);
	});

	it("accepts a replacement backend route when its revision restarts lower", () => {
		expect(
			projectAgentRuntimeLaunchPresentation(
				presentation(9, "retired", "owner-retired", routeA),
				presentation(1, "replacement", "owner-replacement", routeB),
			).launchSelection.model,
		).toBe("replacement");
	});
});
