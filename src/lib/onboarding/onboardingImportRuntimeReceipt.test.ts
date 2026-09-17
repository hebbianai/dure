import { describe, expect, it } from "vitest";
import { onboardingImportRuntimeSucceeded } from "@/lib/onboarding/onboardingImportRuntimeReceipt";

function receipt() {
	return {
		expectedDesktopIds: ["desk-1"],
		expectedAgentIds: ["agent-1", "agent-2"],
		desktops: [
			{
				desktopId: "desk-1",
				expectedPanelIds: ["agent:agent-1", "agent:agent-2"],
				livePanelIds: ["agent:agent-1", "agent:agent-2"],
				attached: true,
			},
		],
		agents: [
			{
				agentId: "agent-1",
				runtime: "hmux_managed_v1",
				started: true,
				sessionClass: "managed",
				lifecycle: "ready",
			},
			{
				agentId: "agent-2",
				runtime: "hmux_managed_v1",
				started: true,
				sessionClass: "managed",
				lifecycle: "ready",
			},
		],
	};
}

describe("onboardingImportRuntimeSucceeded", () => {
	it("accepts exact live panels after every managed pane attaches", () => {
		expect(onboardingImportRuntimeSucceeded(receipt())).toBe(true);
	});

	it("rejects a ready Host whose pane never attached", () => {
		const value = receipt();
		value.desktops[0].attached = false;
		expect(onboardingImportRuntimeSucceeded(value)).toBe(false);
	});

	it("rejects missing, extra, or duplicate live panel identities", () => {
		for (const livePanelIds of [
			["agent:agent-1"],
			["agent:agent-1", "agent:agent-2", "agent:extra"],
			["agent:agent-1", "agent:agent-1"],
		]) {
			const value = receipt();
			value.desktops[0].livePanelIds = livePanelIds;
			expect(onboardingImportRuntimeSucceeded(value)).toBe(false);
		}
	});

	it("rejects a non-managed or non-ready runtime", () => {
		const value = receipt();
		value.agents[1].lifecycle = "exited";
		expect(onboardingImportRuntimeSucceeded(value)).toBe(false);
	});

	it("rejects an agent that has not been marked started", () => {
		const value = receipt();
		delete (value.agents[1] as { started?: boolean }).started;
		expect(onboardingImportRuntimeSucceeded(value)).toBe(false);
	});
});
