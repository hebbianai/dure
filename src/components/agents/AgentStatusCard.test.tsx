// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLabel } from "@/components/agents/StatusBits";
import { useAgentAttention } from "@/lib/agents/agentAttentionStore";
import { t } from "@/lib/i18n";
import { useStore } from "@/store";
import {
	agentFixture,
	hmuxSessionMetadataFixture,
	managedAgentFixture,
} from "@/test/agentFixtures";
import type { Agent, Project } from "@/types";

const mocks = vi.hoisted(() => ({
	openAgentSessionWindow: vi.fn(),
	largeWindowOpen: false,
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
	getCurrentWebviewWindow: () => ({ label: "main" }),
}));
vi.mock("@/lib/workspace/window/windows", () => ({
	openAgentSessionWindow: mocks.openAgentSessionWindow,
}));
vi.mock("@/lib/workspace/window/agentSessionWindowSource", () => ({
	agentSessionSourceIsOpen: () => mocks.largeWindowOpen,
	subscribeAgentSessionSourcePresence: () => () => {},
}));
vi.mock("@/components/workspace/WorkspaceRuntimeContext", () => ({
	useWorkspaceRuntimeDesktopId: () => "desktop-1",
}));

import { AgentStatusCard } from "./AgentStatusCard";

const agent = managedAgentFixture({
	id: "agent-1",
	displayName: "Fix the build",
	branch: "fix/build",
});

function seedAttention(
	attention: Partial<ReturnType<typeof useAgentAttention.getState>>,
) {
	useAgentAttention.setState({
		...useAgentAttention.getInitialState(),
		...attention,
	});
}

function card(cardAgent: Agent = agent, view: "terminal" | "conversation" = "terminal") {
	return render(
		<AgentStatusCard agent={cardAgent} paneId="pane-1" view={view}>
			<span data-testid="pane-control" />
		</AgentStatusCard>,
	);
}

beforeEach(() => {
	mocks.largeWindowOpen = false;
	useStore.setState({
		agents: [agent],
		projects: [{ id: "project-1", name: "repo", path: "/repo" }] as Project[],
		hmuxSessionMetadata: {},
		sessionActivity: { "session-1": { text: "Fix the\nflaky test" } },
		sessionAgentRuntimeState: {},
	});
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	useAgentAttention.setState(useAgentAttention.getInitialState(), true);
});

describe("AgentStatusCard", () => {
	it("says who the agent is, what it is doing and where, from structured facts", () => {
		seedAttention({ displayStates: { "agent-1": "working" } });
		card();
		const row = screen.getByRole("button", { name: /Fix the build/ });
		expect(row.getAttribute("data-variant")).toBe("card");
		expect(row.textContent).toContain(
			[activityLabel("working"), "repo", "fix/build"].join(" · "),
		);
		expect(row.textContent).toContain(
			t("agents.row.asked", { prompt: "Fix the flaky test" }),
		);
		expect(
			screen.getByText(t("workspace.statusCard.enlargeForTerminal")),
		).toBeTruthy();
		// The pane's own hidden controls stay mounted in the card.
		expect(screen.getByTestId("pane-control")).toBeTruthy();
	});

	it("reports why a person is needed, the same way Next up does", () => {
		const now = Date.now();
		useStore.setState({
			hmuxSessionMetadata: hmuxSessionMetadataFixture({
				failure: {
					correlationId: "failure_1",
					sessionId: "session-1",
					workspaceId: "workspace-1",
					terminalEpoch: "terminal-1",
					code: "provider_exited_at_sign_in",
					phase: "conversation_identity",
					summary: "Managed provider exited at its sign-in screen.",
					exitKind: "normal",
					exitCode: 0,
					occurredUnixMs: String(now - 60_000),
					retryPosture: "never",
				},
			}),
		});
		seedAttention({ displayStates: { "agent-1": "exited" } });
		card();
		expect(
			screen.getByRole("button", { name: /Fix the build/ }).textContent,
		).toContain(t("agents.row.signInExit"));
	});

	it("shows a result nobody has looked at, and only that", () => {
		seedAttention({
			displayStates: { "agent-1": "waiting" },
			episodes: { "agent-1": 1 },
			episodeKinds: { "agent-1": "done" },
		});
		card();
		const row = screen.getByRole("button", { name: /Fix the build/ });
		expect(row.textContent).toContain(t("agents.row.result"));

		act(() => useAgentAttention.getState().ack("agent-1"));
		expect(row.textContent).not.toContain(t("agents.row.result"));
		expect(row.textContent).toContain(activityLabel("waiting"));
	});

	it("opens the agent's large window for this pane from the row or the button", () => {
		seedAttention({ displayStates: { "agent-1": "waiting" } });
		card();
		fireEvent.click(
			screen.getByRole("button", { name: t("terminal.largeView.openNotice") }),
		);
		fireEvent.click(screen.getByRole("button", { name: /Fix the build/ }));
		expect(mocks.openAgentSessionWindow).toHaveBeenCalledTimes(2);
		expect(mocks.openAgentSessionWindow).toHaveBeenCalledWith(
			"agent-1",
			"Fix the build",
			"desktop-1:pane-1",
		);
	});

	it("offers to bring the large window forward while it presents this pane", () => {
		mocks.largeWindowOpen = true;
		card();
		expect(
			screen.getByRole("button", { name: t("terminal.largeView.bringToFront") }),
		).toBeTruthy();
	});

	it("shows only the hint for an agent the large window cannot present", () => {
		const unbound = agentFixture({ id: "agent-1", displayName: "Fix the build" });
		useStore.setState({ agents: [unbound] });
		card(unbound, "conversation");
		expect(
			screen.queryByRole("button", { name: t("terminal.largeView.openNotice") }),
		).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: /Fix the build/ }));
		expect(mocks.openAgentSessionWindow).not.toHaveBeenCalled();
		expect(
			screen.getByText(t("workspace.statusCard.enlargeForConversation")),
		).toBeTruthy();
	});
});
