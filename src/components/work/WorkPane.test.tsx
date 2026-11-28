// @vitest-environment jsdom

import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentAttention } from "@/lib/agents/agentAttentionStore";
import { t } from "@/lib/i18n";
import { useWindowSidebarStore } from "@/lib/sidebar/windowSidebarStore";
import {
	resetWindowBootForTest,
	windowContentPainted,
} from "@/lib/workspace/boot/windowBootState";
import { WORK_VIEW_DEFAULT } from "@/lib/work/workViewState";
import { useWorkViewStore } from "@/lib/work/workViewStore";
import { useStore } from "@/store";
import {
	managedAgentFixture,
	managedBindingFixture,
} from "@/test/agentFixtures";
import { PROVIDERS, type Project, type Space } from "@/types";

const navigation = vi.hoisted(() => ({ revealAgent: vi.fn() }));
vi.mock("@/lib/agents/nextUpNavigation", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/agents/nextUpNavigation")>()),
	revealAgent: navigation.revealAgent,
}));

import { WorkMain } from "@/components/work/WorkMain";
import { WorkPane } from "@/components/work/WorkPane";

// app: coordinator ── worker ── helper (an SSH agent, no pane anywhere)
// api: solo
function agent(
	id: string,
	projectId: string,
	parentSession?: string,
	sessionKind: "pty" | "ssh" = "pty",
) {
	return managedAgentFixture({
		id,
		name: id,
		displayName: `Agent ${id}`,
		projectId,
		sessionId: `s-${id}`,
		sessionKind,
		runtimeBinding: managedBindingFixture({ sessionId: `s-${id}` }),
		...(parentSession
			? { runParent: { sessionId: parentSession, workspaceId: "workspace-1" } }
			: {}),
	});
}

const agents = [
	agent("coordinator", "p-app"),
	agent("worker", "p-app", "s-coordinator"),
	agent("helper", "p-app", "s-worker", "ssh"),
	agent("solo", "p-api"),
];

function rowTitles(): string[] {
	return Array.from(
		document.querySelectorAll<HTMLElement>("[data-agent-row-key]"),
	).map((row) => row.dataset.agentRowKey as string);
}

beforeEach(() => {
	useStore.setState({
		agents,
		activeSpaceId: "space-a",
		spaces: [{ id: "space-a", name: "Main" }] as Space[],
		layouts: {},
		projects: [
			{ id: "p-app", name: "app", path: "/app", kind: "local", isRepo: true },
			{ id: "p-api", name: "api", path: "/api", kind: "local", isRepo: true },
		] as Project[],
		hmuxSessionMetadata: {},
		sessionActivity: {},
		sessionAgentRuntimeState: {},
	});
	useAgentAttention.setState({
		...useAgentAttention.getInitialState(),
		displayStates: {
			coordinator: "working",
			worker: "working",
			helper: "blocked",
			solo: "waiting",
		},
		episodes: { helper: 1 },
		episodeKinds: { helper: "approval" },
	});
	useWorkViewStore.setState(WORK_VIEW_DEFAULT);
	useWindowSidebarStore.getState().setTab("work");
	navigation.revealAgent.mockReset();
});

afterEach(() => {
	cleanup();
	useWindowSidebarStore.getState().setTab("spaces");
});

describe("Work list", () => {
	it("lists the top level of each project, and what needs a person at any depth with its path", () => {
		render(<WorkPane />);
		const needsYou = screen.getByRole("region", {
			name: t("agents.nextUp.needsYou"),
		});
		expect(within(needsYou).getByText("Agent helper")).toBeTruthy();
		expect(
			within(needsYou).getByText("Agent coordinator › Agent worker"),
		).toBeTruthy();
		const app = screen.getByRole("region", { name: "app" });
		expect(within(app).getByText("Agent coordinator")).toBeTruthy();
		expect(within(app).queryByText("Agent worker")).toBeNull();
		expect(
			within(screen.getByRole("region", { name: "api" })).getByText("Agent solo"),
		).toBeTruthy();
	});

	it("expands every subtree under its manager", () => {
		render(<WorkPane />);
		act(() =>
			screen.getByRole("radio", { name: t("work.list.expandAll") }).click(),
		);
		const app = screen.getByRole("region", { name: "app" });
		expect(within(app).getByText("Agent worker")).toBeTruthy();
		expect(within(app).getByText("Agent helper")).toBeTruthy();
		expect(useWorkViewStore.getState().depth).toBe("all");
	});

	it("moves the selection with the arrow keys and selects only", () => {
		render(<WorkPane />);
		const before = useStore.getState();
		const first = document.querySelector<HTMLElement>("[data-agent-row-key]");
		first?.focus();
		fireEvent.keyDown(first as HTMLElement, { key: "ArrowDown" });
		expect(useWorkViewStore.getState().selected).toBe("helper");
		fireEvent.keyDown(document.activeElement as HTMLElement, {
			key: "ArrowDown",
		});
		expect(useWorkViewStore.getState().selected).toBe("coordinator");
		expect(
			(document.activeElement as HTMLElement).dataset.agentRowKey,
		).toBe("coordinator");
		fireEvent.keyDown(document.activeElement as HTMLElement, { key: "End" });
		expect(useWorkViewStore.getState().selected).toBe("solo");
		// Selecting opens no pane, switches no Space and acknowledges nothing.
		expect(useStore.getState().activeSpaceId).toBe(before.activeSpaceId);
		expect(useWindowSidebarStore.getState().tab).toBe("work");
		expect(useAgentAttention.getState().acks).toEqual({});
		expect(navigation.revealAgent).not.toHaveBeenCalled();
		expect(rowTitles()).toContain("solo");
	});
});

describe("providers in plain shell panes", () => {
	it("lists a provider found in a shell pane in its project and leaves plain shells to Spaces", () => {
		useStore.setState({
			layouts: {
				"space-a": {
					grid: { width: 1200, height: 800 },
					panels: {
						"term:claude": {
							contentComponent: "terminal",
							params: { sessionId: "shell-claude", cwd: "/app" },
						},
						"term:plain": {
							contentComponent: "terminal",
							params: { sessionId: "shell-plain", cwd: "/app" },
						},
					},
				},
			},
			sessionAgent: { "shell-claude": "claude", "shell-plain": null },
		});
		render(<WorkPane />);
		const app = screen.getByRole("region", { name: "app" });
		const shell = within(app).getByText(PROVIDERS.claude.label);
		expect(rowTitles()).not.toContain("pane:space-a:term:plain");

		act(() => (shell.closest("button") as HTMLButtonElement).click());
		expect(useWorkViewStore.getState().selected).toBe("pane:space-a:term:claude");
		cleanup();
		render(<WorkMain />);
		act(() =>
			screen.getByRole("button", { name: t("work.detail.showInSpace") }).click(),
		);
		// Going to its pane brings the Spaces deck forward.
		expect(useWindowSidebarStore.getState().tab).toBe("spaces");
	});
});

describe("a lead in a plain shell pane", () => {
	// A person ran `dure run` in a plain shell: the Run records the shell's
	// Hmux Session, which no Agent owns, and no provider runs in it now.
	const shellKey = "pane:space-a:term:lead";
	beforeEach(() => {
		useStore.setState({
			agents: [
				...agents,
				managedAgentFixture({
					id: "started",
					name: "started",
					displayName: "Agent started",
					projectId: "p-app",
					sessionId: "s-started",
					runtimeBinding: managedBindingFixture({ sessionId: "s-started" }),
					runParent: { sessionId: "hmux-shell", workspaceId: "workspace-1" },
				}),
			],
			layouts: {
				"space-a": {
					grid: { width: 1200, height: 800 },
					panels: {
						"term:lead": {
							contentComponent: "terminal",
							params: {
								sessionId: "shell-lead",
								cwd: "/app",
								binding: {
									runtime: "hmux_session_v1",
									sessionId: "hmux-shell",
									workspaceId: "workspace-1",
								},
							},
						},
					},
				},
			},
			sessionAgent: { "shell-lead": null },
		});
	});

	it("lists the shell with what it started, under it when expanded", () => {
		render(<WorkPane />);
		expect(rowTitles()).toContain(shellKey);
		expect(rowTitles()).not.toContain("started");
		const shellRow = document.querySelector(`[data-agent-row-key="${shellKey}"]`);
		expect(shellRow?.textContent).toContain(t("agents.row.manages", { n: 1 }));
		act(() => useWorkViewStore.getState().setDepth("all"));
		const order = rowTitles();
		expect(order.indexOf("started")).toBe(order.indexOf(shellKey) + 1);
	});

	it("names the shell above the agent and the agent in the shell's detail", () => {
		useWorkViewStore.getState().select("started");
		render(<WorkMain />);
		const crumbs = screen.getByRole("navigation", {
			name: t("work.detail.managers"),
		});
		act(() => within(crumbs).getByRole("button", { name: "app" }).click());
		expect(useWorkViewStore.getState().selected).toBe(shellKey);
		const detail = screen.getByRole("region", { name: t("work.detail.label") });
		expect(
			detail.querySelector('[data-agent-row-key="started"]'),
		).toBeTruthy();
	});
});

describe("Work main area", () => {
	it("shows the selected agent as its card, with a way to its Space", () => {
		useWorkViewStore.getState().select("solo");
		render(<WorkMain />);
		const detail = screen.getByRole("region", {
			name: t("work.detail.label"),
		});
		expect(within(detail).getByText("Agent solo")).toBeTruthy();
		act(() =>
			within(detail)
				.getByRole("button", { name: t("work.detail.showInSpace") })
				.click(),
		);
		expect(navigation.revealAgent).toHaveBeenCalledWith("solo");
	});

	it("carries the list itself while the sidebar is collapsed", () => {
		useWindowSidebarStore.setState({ open: false });
		try {
			render(<WorkMain />);
			expect(screen.getByRole("heading", { name: t("work.title") })).toBeTruthy();
		} finally {
			useWindowSidebarStore.setState({ open: true });
		}
	});

	it("ends the window's boot when Work is what it opens on", async () => {
		resetWindowBootForTest();
		render(<WorkMain />);
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 50));
		});
		expect(windowContentPainted()).toBe(true);
	});
});
