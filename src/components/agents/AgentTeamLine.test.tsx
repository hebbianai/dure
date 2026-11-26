// @vitest-environment jsdom

import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLabel } from "@/components/agents/StatusBits";
import { useAgentAttention } from "@/lib/agents/agentAttentionStore";
import { t } from "@/lib/i18n";
import { useStore } from "@/store";
import {
	managedAgentFixture,
	managedBindingFixture,
} from "@/test/agentFixtures";
import type { Project, Space } from "@/types";

const navigation = vi.hoisted(() => ({
	agentRevealTargets: vi.fn(),
	revealAgent: vi.fn(),
}));
const windows = vi.hoisted(() => ({ isMainWindow: vi.fn(() => true) }));
vi.mock("@/lib/agents/nextUpNavigation", () => navigation);
vi.mock("@/lib/workspace/window/windows", () => windows);

import { AgentTeamLine } from "./AgentTeamLine";

// coordinator ─┬─ lead ── worker ── helper
//              └─ reviewer
// solo
const team = [
	["coordinator", undefined],
	["lead", "s-coordinator"],
	["reviewer", "s-coordinator"],
	["worker", "s-lead"],
	["helper", "s-worker"],
	["solo", undefined],
].map(([id, parentSession]) =>
	managedAgentFixture({
		id,
		name: id,
		displayName: `Agent ${id}`,
		sessionId: `s-${id}`,
		runtimeBinding: managedBindingFixture({ sessionId: `s-${id}` }),
		...(parentSession
			? { runParent: { sessionId: parentSession, workspaceId: "workspace-1" } }
			: {}),
	}),
);

function seed(
	attention: Partial<ReturnType<typeof useAgentAttention.getState>>,
) {
	useAgentAttention.setState({
		...useAgentAttention.getInitialState(),
		...attention,
	});
}

function managedText(count: number, needYou: number, working: number): string {
	return [
		t("agents.row.manages", { n: count }),
		...(needYou > 0 ? [t("agents.row.managedNeedYou", { n: needYou })] : []),
		...(working > 0 ? [t("agents.row.managedWorking", { n: working })] : []),
	].join(" · ");
}

function line() {
	return screen.getByRole("region", { name: t("agents.team.label") });
}

async function unfold() {
	const summary = line().querySelector("summary");
	if (!summary) throw new Error("the team line has no fold");
	fireEvent.click(summary);
	await waitFor(() =>
		expect(within(line()).queryAllByRole("button").length).toBeGreaterThan(0),
	);
	return within(line()).getAllByRole("button");
}

beforeEach(() => {
	useStore.setState({
		agents: team,
		activeSpaceId: "space-a",
		spaces: [
			{ id: "space-a", name: "Main" },
			{ id: "space-b", name: "Review" },
		] as Space[],
		projects: [] as Project[],
		hmuxSessionMetadata: {},
		sessionActivity: {},
		sessionAgentRuntimeState: {},
	});
	seed({
		displayStates: {
			coordinator: "working",
			lead: "working",
			reviewer: "waiting",
			worker: "working",
			helper: "input",
		},
	});
	windows.isMainWindow.mockReturnValue(true);
	navigation.agentRevealTargets.mockImplementation(
		(agentIds: readonly string[]) =>
			new Map(
				agentIds.map((agentId) => [
					agentId,
					agentId === "helper"
						? { kind: "pane", desktopId: "space-b", panelId: "pane-helper" }
						: {
								kind: "pane",
								desktopId: "space-a",
								panelId: `pane-${agentId}`,
							},
				]),
			),
	);
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	useAgentAttention.setState(useAgentAttention.getInitialState(), true);
});

describe("AgentTeamLine", () => {
	it("folds what an agent manages into one line, counted over its whole team", () => {
		render(<AgentTeamLine agentId="coordinator" />);
		expect(line().textContent).toBe(managedText(4, 1, 2));
		// Folded, it lists and subscribes to no row.
		expect(within(line()).queryAllByRole("button")).toEqual([]);
	});

	it("is absent for an agent that manages none", () => {
		for (const agentId of ["solo", "helper", "unknown-agent"]) {
			const { container } = render(<AgentTeamLine agentId={agentId} />);
			expect(container.innerHTML).toBe("");
			cleanup();
		}
	});

	it("belongs to the main window only", () => {
		windows.isMainWindow.mockReturnValue(false);
		const { container } = render(<AgentTeamLine agentId="coordinator" />);
		expect(container.innerHTML).toBe("");
	});

	it("unfolds to the agents it manages directly, then anyone further down who needs a person, with the path from here", async () => {
		render(<AgentTeamLine agentId="coordinator" />);
		const [lead, reviewer, helper, ...rest] = await unfold();
		expect(rest).toEqual([]);

		// A direct agent: no path, and what it manages in turn.
		expect(lead.getAttribute("data-variant")).toBe("line");
		expect(lead.textContent).toContain("Agent lead");
		expect(lead.textContent).not.toContain("›");
		expect(lead.textContent).toContain(managedText(2, 1, 1));
		expect(reviewer.textContent).toBe("Agent reviewer");

		// Three levels down: the managers between, never the agent the line is on.
		expect(helper.textContent).toContain("Agent lead › Agent worker ›");
		expect(helper.textContent).toContain("Agent helper");
		expect(helper.textContent).not.toContain("Agent coordinator");
		expect(helper.textContent).toContain(activityLabel("input"));
		// Its row names the Space selecting it leads to.
		expect(helper.textContent).toContain("Review");
	});

	it("brings a selected agent forward", async () => {
		render(<AgentTeamLine agentId="coordinator" />);
		const [, , helper] = await unfold();
		fireEvent.click(helper);
		expect(navigation.revealAgent).toHaveBeenCalledWith("helper");
	});

	it("follows attention live, without rebuilding who manages whom", async () => {
		render(<AgentTeamLine agentId="coordinator" />);
		act(() =>
			useAgentAttention.setState({
				displayStates: {
					coordinator: "working",
					lead: "blocked",
					reviewer: "error",
					worker: "waiting",
					helper: "waiting",
				},
			}),
		);
		expect(line().textContent).toBe(managedText(4, 2, 0));
		// Nobody below the direct agents needs a person now.
		const [lead, reviewer, ...rest] = await unfold();
		expect(rest).toEqual([]);
		expect(lead.textContent).toContain("Agent lead");
		expect(lead.textContent).toContain(activityLabel("blocked"));
		expect(reviewer.textContent).toContain("Agent reviewer");
		expect(reviewer.textContent).toContain(activityLabel("error"));
	});
});
