// @vitest-environment jsdom
import { createDockview } from "dockview-react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { maybeAutoOpenOnboarding, openOnboardingPanel } from "./onboardingEntry";
import { useStore } from "@/store";
import {
	registerDockview,
	unregisterDockview,
} from "@/lib/workspace/dock/dockRegistry";

const dispose: Array<() => void> = [];
const initialState = useStore.getState();
beforeEach(() => {
	useStore.setState({
		projects: [],
		uiPrefs: { ...initialState.uiPrefs, onboardingDismissed: false },
	});
});
afterEach(() => {
	for (const cleanup of dispose.splice(0).reverse()) cleanup();
	useStore.setState(initialState, true);
});

function desktop(id = "guide-space") {
	const element = document.createElement("div");
	document.body.append(element);
	const api = createDockview(element, {
		createComponent: () => ({
			element: document.createElement("div"),
			init() {},
		}),
	});
	api.layout(1200, 800);
	registerDockview(id, api);
	dispose.push(() => {
		unregisterDockview(id, api);
		api.dispose();
		element.remove();
	});
	return api;
}

describe("onboarding view identity", () => {
	it.each(["onboarding:main", "pane-restored-guide", "agent:historical-slot"])(
		"preserves restored selection when automatically ensuring guide %s",
		(id) => {
			const api = desktop();
			api.addPanel({ id, component: "onboarding" });
			api.addPanel({
				id: "pane-selected-terminal",
				component: "terminal",
				params: { draft: "keep", sessionId: "exact-session" },
				position: { referencePanel: id, direction: "right" },
			});
			api.fromJSON(api.toJSON());
			const restoredLayout = api.toJSON();
			const selected = api.getPanel("pane-selected-terminal")!;
			const guide = api.getPanel(id)!;
			expect(api.activePanel).toBe(selected);

			maybeAutoOpenOnboarding("guide-space");
			maybeAutoOpenOnboarding("guide-space");

			expect(api.activePanel).toBe(selected);
			expect(api.getPanel(id)).toBe(guide);
			expect(api.toJSON()).toEqual(restoredLayout);
			openOnboardingPanel("guide-space");
			expect(api.activePanel).toBe(guide);
		},
	);

	it("opens a missing first-run guide beside existing content without repeatedly taking selection", () => {
		const api = desktop();
		const terminal = api.addPanel({
			id: "pane-existing-terminal",
			component: "terminal",
			params: { draft: "unsent work" },
		});
		maybeAutoOpenOnboarding("guide-space");
		const guide = api.activePanel!;
		expect(guide.api.component).toBe("onboarding");
		expect(guide.id).toMatch(/^pane-[A-Za-z0-9_-]+$/);
		expect(api.getPanel(terminal.id)).toBe(terminal);
		expect(terminal.params).toEqual({ draft: "unsent work" });
		expect(api.panels).toHaveLength(2);
		terminal.api.setActive();
		const selectedLayout = api.toJSON();

		maybeAutoOpenOnboarding("guide-space");

		expect(api.activePanel).toBe(terminal);
		expect(api.toJSON()).toEqual(selectedLayout);
	});

	it("allocates independent views in different Spaces and reuses current guide content", () => {
		const first = desktop("first-space");
		const second = desktop("second-space");
		openOnboardingPanel("first-space");
		openOnboardingPanel("second-space");
		const guide = first.panels[0];
		expect(guide.id).toMatch(/^pane-[A-Za-z0-9_-]+$/);
		expect(second.panels[0].id).not.toBe(guide.id);
		openOnboardingPanel("first-space");
		expect(first.panels).toEqual([guide]);
		expect(first.activePanel).toBe(guide);
	});

	it.each(["onboarding:main", "pane-restored-guide", "agent:historical-slot"])(
		"reuses restored onboarding content without renaming %s",
		(id) => {
			const api = desktop();
			api.addPanel({ id, component: "onboarding" });
			api.addPanel({
				id: "pane-sibling",
				component: "terminal",
				params: { draft: "keep" },
			});
			const saved = api.toJSON();
			api.fromJSON(saved);
			const guide = api.getPanel(id)!;
			const sibling = api.getPanel("pane-sibling");
			openOnboardingPanel("guide-space");
			expect(api.panels).toHaveLength(2);
			expect(api.getPanel(id)).toBe(guide);
			expect(api.getPanel("pane-sibling")).toBe(sibling);
			expect(api.activePanel).toBe(guide);
			expect(sibling?.params).toEqual({ draft: "keep" });
		},
	);

	it("does not reuse a historical guide ID after its content became a terminal", () => {
		const api = desktop();
		const original = api.addPanel({
			id: "onboarding:main",
			component: "onboarding",
		});
		api.replacePanel(original.api, {
			component: "terminal",
			params: { draft: "unsent user work" },
		});
		const terminal = api.getPanel(original.id)!;
		const group = terminal.group;
		openOnboardingPanel("guide-space");
		expect(api.panels).toHaveLength(2);
		expect(api.getPanel(terminal.id)).toBe(terminal);
		expect(terminal.group).toBe(group);
		expect(terminal.params).toEqual({ draft: "unsent user work" });
		expect(api.activePanel?.api.component).toBe("onboarding");
		expect(api.activePanel?.id).not.toBe(terminal.id);
	});
});
