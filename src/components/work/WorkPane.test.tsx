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
import {
	endedFoldKey,
	RESULTS_TODAY_FOLD_KEY,
	workGroupKey,
} from "@/lib/work/workViewList";
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

describe("ended agents", () => {
	it("fold per project, closed, while live and unknown agents stay open", () => {
		useAgentAttention.setState({
			...useAgentAttention.getInitialState(),
			displayStates: {
				coordinator: "exited",
				worker: "exited",
				helper: "exited",
				solo: "unknown",
			},
		});
		render(<WorkPane />);
		const app = screen.getByRole("region", { name: "app" });
		const label = within(app).getByText(`${t("work.list.ended")} · 1`);
		const fold = label.closest("details") as HTMLDetailsElement;
		expect(fold.open).toBe(false);
		expect(within(fold).getByText("Agent coordinator")).toBeTruthy();
		// Nothing is removed: the whole tree is listed under its root.
		act(() => useWorkViewStore.getState().setDepth("all"));
		expect(
			within(screen.getByRole("region", { name: "app" })).getByText(
				`${t("work.list.ended")} · 3`,
			),
		).toBeTruthy();
		// Status unavailable is not an exit: it never folds.
		const api = screen.getByRole("region", { name: "api" });
		expect(within(api).queryByText(new RegExp(t("work.list.ended")))).toBeNull();
		expect(within(api).getByText("Agent solo")).toBeTruthy();
	});

	it("holds a row that ends under the pointer until the pointer leaves the list", () => {
		render(<WorkPane />);
		const app = () => screen.getByRole("region", { name: "app" });
		const list = app().parentElement as HTMLElement;
		fireEvent.pointerEnter(list);
		act(() =>
			useAgentAttention.setState({
				displayStates: {
					coordinator: "exited",
					worker: "exited",
					helper: "exited",
					solo: "waiting",
				},
			}),
		);
		// The dot already reads the exit; the row stays where it was.
		expect(within(app()).queryByText(new RegExp(t("work.list.ended")))).toBeNull();
		act(() => {
			fireEvent.pointerLeave(list);
		});
		expect(within(app()).getByText(`${t("work.list.ended")} · 1`)).toBeTruthy();
	});

	it("keeps a root open while anything it manages is still working", () => {
		useAgentAttention.setState({
			...useAgentAttention.getInitialState(),
			displayStates: {
				coordinator: "exited",
				worker: "exited",
				helper: "working",
				solo: "waiting",
			},
		});
		render(<WorkPane />);
		const app = screen.getByRole("region", { name: "app" });
		expect(within(app).queryByText(new RegExp(t("work.list.ended")))).toBeNull();
		expect(within(app).getByText("Agent coordinator")).toBeTruthy();
	});

	it("opens one project's fold without opening the others", () => {
		useAgentAttention.setState({
			...useAgentAttention.getInitialState(),
			displayStates: {
				coordinator: "exited",
				worker: "exited",
				helper: "exited",
				solo: "exited",
			},
		});
		render(<WorkPane />);
		const folds = () =>
			["app", "api"].map(
				(name) =>
					(
						within(screen.getByRole("region", { name })).getByText(
							new RegExp(t("work.list.ended")),
						).closest("details") as HTMLDetailsElement
					).open,
			);
		expect(folds()).toEqual([false, false]);
		const appFold = endedFoldKey(workGroupKey("project", "p-app"));
		const apiFold = endedFoldKey(workGroupKey("project", "p-api"));
		act(() =>
			useWorkViewStore
				.getState()
				.setFoldOpen(appFold, true, [appFold, apiFold, RESULTS_TODAY_FOLD_KEY]),
		);
		expect(folds()).toEqual([true, false]);
		// Arrow keys reach the rows of an open fold only.
		const first = document.querySelector<HTMLElement>("[data-agent-row-key]");
		first?.focus();
		fireEvent.keyDown(first as HTMLElement, { key: "End" });
		expect(useWorkViewStore.getState().selected).toBe("coordinator");
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
