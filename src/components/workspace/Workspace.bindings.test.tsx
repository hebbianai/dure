// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { type DependencyList, type EffectCallback, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
	revision: 0,
	projections: new Set<() => boolean>(),
	pushes: new Set<() => void>(),
}));

// React Refresh replays source-component effects without remounting the
// prebundled Dockview child. Real Vite/WebKit QA covers the refresh transport;
// this forces the same effect lifecycle on the real Workspace and Dockview.
vi.mock("react", async (importOriginal) => {
	const actual = await importOriginal<typeof import("react")>();
	const replay =
		(hook: typeof actual.useEffect) =>
		(effect: EffectCallback, deps?: DependencyList) =>
			hook(effect, deps ? [...deps, fixture.revision] : deps);
	return {
		...actual,
		useEffect: replay(actual.useEffect),
		useLayoutEffect: replay(actual.useLayoutEffect),
	};
});

vi.mock("@/components/workspace/PaneLauncher", () => ({
	PaneLauncher: () => null,
}));
vi.mock("@/components/workspace/PaneChrome", () => ({
	PaneChrome: () => null,
}));
vi.mock("@/components/panels/AgentPanel", () => ({ AgentPanel: () => null }));
vi.mock("@/components/panels/TerminalPanel", () => ({
	TerminalPanel: () => null,
}));
vi.mock("@/components/workspace/DesktopWatermark", () => ({
	DesktopWatermark: () => null,
}));
vi.mock("@/components/workspace/ChatDraftMoveNotice", () => ({
	ChatDraftMoveNotice: () => null,
}));
vi.mock("@/components/panels/OnboardingPanel", () => ({
	OnboardingPanel: () => null,
}));
vi.mock("@/lib/onboarding/onboardingEntry", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@/lib/onboarding/onboardingEntry")
	>()),
	maybeAutoOpenOnboarding: vi.fn(),
}));
vi.mock("@/lib/workspace/pane/paneWindowTransferRuntime", () => ({
	installPaneWindowDropTarget: () => () => {},
}));
vi.mock("@/lib/persistence/durableStoreRehydration", () => ({
	rehydrateDurableStore: vi.fn(),
	subscribeDurableStoreLayoutProjection: (
		_id: string,
		callback: () => boolean,
	) => {
		fixture.projections.add(callback);
		return () => fixture.projections.delete(callback);
	},
}));
vi.mock("@/lib/workspace/layout/layoutPushChannel", () => ({
	projectPushedLayout: vi.fn(),
	onLayoutPush: (callback: () => void) => {
		fixture.pushes.add(callback);
		return () => fixture.pushes.delete(callback);
	},
}));

import { DURE_NEW_PANE_DRAG_TYPE } from "@/lib/platform/productDragPayload";
import { getDockview, movingPanels } from "@/lib/workspace/dock/dockRegistry";
import { paneDragPerformance } from "@/lib/workspace/performance/paneDragPerformance";
import { useStore } from "@/store";
import { agentFixture } from "@/test/agentFixtures";
import { Workspace } from "./Workspace";

beforeEach(() => {
	fixture.revision = 0;
	useStore.setState((state) => ({
		projects: [],
		agents: [],
		focusCtx: null,
		layouts: {},
		uiPrefs: { ...state.uiPrefs, splitterSize: 2, onboardingDismissed: false },
	}));
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("Workspace binding lifetime", () => {
	it.each([
		["pane-guide", "onboarding", true],
		["onboarding:main", "onboarding", true],
		["onboarding:main", "terminal", false],
	] as const)(
		"closing %s with %s content records only a real guide dismissal",
		async (id, component, dismissed) => {
			render(<Workspace desktopId="guide-fixture" active />);
			const api = getDockview("guide-fixture")!;
			await act(async () => {
				api.layout(1000, 600);
				api.addPanel({ id, component });
			});
			act(() => api.removePanel(api.getPanel(id)!));
			expect(useStore.getState().uiPrefs.onboardingDismissed).toBe(dismissed);
		},
	);

	it("does not dismiss a guide when its view leaves for another Space", async () => {
		render(<Workspace desktopId="guide-fixture" active />);
		const api = getDockview("guide-fixture")!;
		await act(async () => {
			api.addPanel({ id: "pane-guide", component: "onboarding" });
		});
		movingPanels.add("pane-guide");
		try {
			act(() => api.removePanel(api.getPanel("pane-guide")!));
			expect(useStore.getState().uiPrefs.onboardingDismissed).toBe(false);
		} finally {
			movingPanels.delete("pane-guide");
		}
	});

	it("updates the same group's controls when content changes without add/remove", async () => {
		render(<Workspace desktopId="guide-fixture" active />);
		const api = getDockview("guide-fixture")!;
		await act(async () => {
			api.layout(1000, 600);
			api.addPanel({ id: "onboarding:main", component: "onboarding" });
		});
		const guide = api.getPanel("onboarding:main")!;
		const group = guide.group;
		await waitFor(() => expect(group.header.hidden).toBe(true));
		act(() => {
			api.replacePanel(guide.api, {
				component: "terminal",
				params: { draft: "keep" },
			});
		});
		await waitFor(() => expect(group.header.hidden).toBe(false));
		expect(api.getPanel(guide.id)?.group).toBe(group);
		expect(api.getPanel(guide.id)?.params).toEqual({ draft: "keep" });
		expect(useStore.getState().uiPrefs.onboardingDismissed).toBe(false);
		act(() => {
			api.replacePanel(api.getPanel(guide.id)!.api, {
				component: "onboarding",
			});
		});
		await waitFor(() => expect(group.header.hidden).toBe(true));
	});

	it.each([false, true])(
		"updates the focused Agent reference without moving or recreating its pane (StrictMode: %s)",
		async (strict) => {
			useStore.setState({
				agents: [
					agentFixture({ id: "current", worktreePath: "/same" }),
					agentFixture({ id: "other", worktreePath: "/same" }),
				],
			});
			const workspace = <Workspace desktopId="context-fixture" active />;
			const view = render(
				strict ? <StrictMode>{workspace}</StrictMode> : workspace,
			);
			const api = getDockview("context-fixture")!;
			act(() => {
				api.layout(1000, 600);
				api.addPanel({
					id: "slot",
					component: "agent",
					params: { agentRef: { agentId: "current" } },
				});
			});
			const panel = api.getPanel("slot")!;
			await waitFor(() =>
				expect(useStore.getState().focusCtx?.agentId).toBe("current"),
			);
			act(() => panel.api.updateParameters({ agentRef: { agentId: "other" } }));
			await waitFor(() =>
				expect(useStore.getState().focusCtx?.agentId).toBe("other"),
			);
			expect(api.getPanel("slot")).toBe(panel);
			expect(api.activePanel).toBe(panel);
			act(() => panel.api.updateParameters({ agentRef: null }));
			await waitFor(() => expect(useStore.getState().focusCtx).toBeNull());
			expect(api.getPanel("slot")).toBe(panel);
			act(() => {
				fixture.revision += 1;
				useStore.getState().setUiPrefs({ splitterSize: 3 });
			});
			act(() => {
				panel.api.updateParameters({ agentRef: { agentId: "current" } });
				panel.api.updateParameters({ agentRef: { agentId: "other" } });
			});
			await waitFor(() =>
				expect(useStore.getState().focusCtx?.agentId).toBe("other"),
			);
			expect(api.getPanel("slot")).toBe(panel);
			view.unmount();
			expect(getDockview("context-fixture")).toBeUndefined();
		},
	);
	it("does not let a background Space or a late old-pane update replace the active context", async () => {
		useStore.setState({
			agents: [agentFixture({ id: "current" }), agentFixture({ id: "other" })],
		});
		render(
			<>
				<Workspace desktopId="foreground-fixture" active />
				<Workspace desktopId="background-fixture" active={false} />
			</>,
		);
		const foreground = getDockview("foreground-fixture")!;
		const background = getDockview("background-fixture")!;
		act(() => {
			foreground.layout(1000, 600);
			background.layout(1000, 600);
			foreground.addPanel({
				id: "selected",
				component: "agent",
				params: { agentRef: { agentId: "current" } },
			});
			background.addPanel({
				id: "background",
				component: "agent",
				params: { agentRef: { agentId: "other" } },
			});
		});
		await waitFor(() =>
			expect(useStore.getState().focusCtx?.key).toBe("selected"),
		);
		const old = foreground.getPanel("selected")!;
		act(() => {
			foreground.addPanel({
				id: "new-selection",
				component: "agent",
				params: { agentRef: { agentId: "other" } },
				position: { referencePanel: old.id, direction: "right" },
			});
			old.api.updateParameters({ agentRef: { agentId: "current" } });
			background
				.getPanel("background")!
				.api.updateParameters({ agentRef: { agentId: "current" } });
		});
		await waitFor(() =>
			expect(useStore.getState().focusCtx).toMatchObject({
				key: "new-selection",
				agentId: "other",
			}),
		);
	});
	it.each([false, true])(
		"reconnects without replacing panes or duplicating subscriptions (StrictMode: %s)",
		async (strict) => {
			const workspace = <Workspace desktopId="refresh-fixture" active />;
			const view = render(
				strict ? <StrictMode>{workspace}</StrictMode> : workspace,
			);
			const api = getDockview("refresh-fixture")!;
			act(() => {
				api.layout(1000, 600);
				api.addPanel({ id: "target", component: "launcher" });
			});
			const panel = api.getPanel("target")!;
			const restore = vi.spyOn(api, "fromJSON");
			vi.spyOn(document, "hasFocus").mockReturnValue(true);
			const layout = JSON.stringify(api.toJSON().grid);
			vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(
				1000,
			);
			vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(
				600,
			);
			vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
				new DOMRect(0, 0, 1000, 600),
			);

			for (let revision = 0; revision < 4; revision += 1) {
				if (revision) {
					act(() => {
						fixture.revision = revision;
						useStore.getState().setUiPrefs({ splitterSize: 2 + revision });
					});
				}
				expect(getDockview("refresh-fixture")).toBeDefined();
				expect(getDockview("refresh-fixture")).toBe(api);
				expect(api.getPanel("target")).toBe(panel);
				expect(JSON.stringify(api.toJSON().grid)).toBe(layout);
				expect(restore).not.toHaveBeenCalled();
				expect(fixture.projections.size).toBe(1);
				expect(fixture.pushes.size).toBe(1);
				const beforeHover = paneDragPerformance.snapshot().recent;
				const previous = beforeHover[beforeHover.length - 1]?.receivedAt ?? -1;
				const event = new MouseEvent("dragover", {
					bubbles: true,
					cancelable: true,
					clientX: 500,
					clientY: 560,
				});
				Object.defineProperty(event, "dataTransfer", {
					value: { types: [DURE_NEW_PANE_DRAG_TYPE], dropEffect: "none" },
				});
				panel.group.element
					.querySelector(".dv-content-container")!
					.dispatchEvent(event);
				await Promise.resolve();
				expect(event.defaultPrevented).toBe(true);
				expect(
					view.container.querySelector<HTMLElement>(".dv-drop-target-selection")
						?.dataset.paneDropIntent,
				).toBe("split-bottom");
				const afterHover = paneDragPerformance.snapshot().recent;
				expect(afterHover[afterHover.length - 1]?.receivedAt).toBeGreaterThan(
					previous,
				);
				window.dispatchEvent(
					new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
				);
				act(() => panel.api.setTitle(`Retained pane ${revision}`));
				await waitFor(() => {
					const saved = useStore.getState().layouts[
						"refresh-fixture"
					] as ReturnType<typeof api.toJSON>;
					expect(saved.panels.target.title).toBe(`Retained pane ${revision}`);
				});
			}
			const external = api.toJSON();
			external.panels.target.title = "Projected after refresh";
			act(() => {
				useStore.getState().saveLayout("refresh-fixture", external);
				for (const project of fixture.projections) expect(project()).toBe(true);
			});
			expect(restore).toHaveBeenCalledOnce();
			expect(api.getPanel("target")).toBe(panel);
			expect(panel.title).toBe("Projected after refresh");
			// Refresh before the projection's deferred guard release. Reconnecting
			// must not strand ordinary saves behind a cancelled timer.
			act(() => {
				fixture.revision += 1;
				useStore.getState().setUiPrefs({ splitterSize: 2 });
			});
			act(() => panel.api.setTitle("Saved after projection refresh"));
			await waitFor(() => {
				const saved = useStore.getState().layouts[
					"refresh-fixture"
				] as ReturnType<typeof api.toJSON>;
				expect(saved.panels.target.title).toBe(
					"Saved after projection refresh",
				);
			});
			view.unmount();
			expect(getDockview("refresh-fixture")).toBeUndefined();
			expect(fixture.projections.size).toBe(0);
			expect(fixture.pushes.size).toBe(0);
		},
	);
});
