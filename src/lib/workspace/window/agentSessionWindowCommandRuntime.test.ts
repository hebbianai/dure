import { describe, expect, it, vi } from "vitest";
import { t } from "@/lib/i18n";
import { agentFixture } from "@/test/agentFixtures";
import {
	type AgentSessionWindowCommandRuntime,
	executeAgentSessionWindowCommand,
} from "./agentSessionWindowCommandRuntime";

const forkedAgent = agentFixture({
	id: "agent-fork",
	sessionId: "agent-fork",
	displayName: "Fork",
});

function presentationRuntime(options: { present?: boolean } = {}) {
	const order: string[] = [];
	const state = {
		agents: [forkedAgent],
		spaces: [{ id: "desktop-source" }, { id: "desktop-other" }],
	};
	const runtime: AgentSessionWindowCommandRuntime = {
		reconcile: vi.fn(async () => {
			order.push("reconcile");
		}),
		readState: vi.fn(() => {
			order.push("read");
			return state;
		}),
		readPaneAgentId: vi.fn(() => "agent-source"),
		activateSourcePane: vi.fn((desktopId, panelId) => {
			order.push(`source:${desktopId}:${panelId}`);
			return true;
		}),
		ownsMountedPane: vi.fn((desktopId, panelId) => {
			order.push(`owns:${desktopId}:${panelId}`);
			return true;
		}),
		ownsMountedAgentPane: vi.fn((desktopId, agentId) => {
			order.push(`owns-agent:${desktopId}:${agentId}`);
			return true;
		}),
		waitForDesktop: vi.fn(async (desktopId) => {
			order.push(`wait:${desktopId}`);
			return true;
		}),
		presentAgent: vi.fn((desktopId, agent) => {
			order.push(`present:${desktopId}:${agent.id}`);
			return options.present ?? true;
		}),
	};
	return { order, runtime, state };
}

const command = {
	action: "present_fork" as const,
	agentId: "agent-source",
	desktopId: "desktop-source",
	panelId: "agent:agent-source",
	forkedAgentId: "agent-fork",
};

describe("Agent session window command runtime", () => {
	it("hydrates, activates, and presents the fork in the source-owned desktop before acknowledging", async () => {
		const { order, runtime } = presentationRuntime();

		await expect(
			executeAgentSessionWindowCommand(command, runtime),
		).resolves.toEqual({ kind: "presented" });
		expect(runtime.reconcile).toHaveBeenCalledTimes(2);
		expect(runtime.reconcile).toHaveBeenCalledWith("desktop-source");
		expect(runtime.activateSourcePane).toHaveBeenCalledTimes(2);
		expect(runtime.activateSourcePane).toHaveBeenCalledWith(
			"desktop-source",
			"agent:agent-source",
		);
		expect(runtime.presentAgent).toHaveBeenCalledWith(
			"desktop-source",
			forkedAgent,
		);
		expect(runtime.ownsMountedPane).toHaveBeenCalledWith(
			"desktop-source",
			"agent:agent-source",
		);
		expect(runtime.ownsMountedAgentPane).toHaveBeenCalledWith(
			"desktop-source",
			"agent-fork",
		);
		expect(order).toEqual([
			"reconcile",
			"source:desktop-source:agent:agent-source",
			"wait:desktop-source",
			"source:desktop-source:agent:agent-source",
			"read",
			"present:desktop-source:agent-fork",
			"reconcile",
			"owns:desktop-source:agent:agent-source",
			"owns-agent:desktop-source:agent-fork",
		]);
	});

	it("rejects the receipt when the source dock cannot present the fork", async () => {
		const { runtime } = presentationRuntime({ present: false });

		await expect(
			executeAgentSessionWindowCommand(command, runtime),
		).rejects.toThrow(t("workspace.agentWindow.forkPresentationFailed"));
	});
});
