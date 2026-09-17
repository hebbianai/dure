import type { createDockview } from "dockview-react";

/** Exercise the installed library's public contract across CJS, Vite and ESM. */
export function assertPaneContentReplacement(
	document: Document,
	create: typeof createDockview,
) {
	const element = document.createElement("div");
	document.body.append(element);
	const api = create(element, {
		defaultTabComponent: "header",
		createTabComponent: () => ({
			element: document.createElement("div"),
			init() {},
		}),
		createComponent: ({ name }) => ({
			element: document.createElement("div"),
			init() {
				if (name === "broken") throw new Error("injected init failure");
			},
		}),
	});
	try {
		api.layout(1000, 700);
		const previous = api.addPanel({
			id: "slot",
			component: "launcher",
			params: { cwd: "/repo" },
		});
		const sibling = api.addPanel({
			id: "sibling",
			component: "terminal",
			position: { referencePanel: previous.id, direction: "right" },
		});
		previous.api.setActive();
		const before = api.toJSON();
		const next = api.replacePanel(previous.api, {
			component: "terminal",
			params: { sessionId: "runtime" },
		});
		if (
			!next ||
			next.id !== previous.id ||
			api.getPanel(previous.id) !== next ||
			api.activePanel !== next ||
			next.group !== previous.group ||
			api.panels.length !== 2
		)
			throw new Error("content replacement did not preserve the pane slot");
		if (api.replacePanel(previous.api, { component: "agent" }) !== undefined)
			throw new Error("late content replacement overwrote the current pane");
		let failure: unknown;
		try {
			api.replacePanel(next.api, { component: "broken" });
		} catch (error) {
			failure = error;
		}
		if (
			!(failure instanceof Error) ||
			failure.message !== "injected init failure" ||
			api.getPanel(next.id) !== next
		)
			throw new Error("failed content initialization removed the current pane");
		api.fromJSON(before, { reuseExistingPanels: true });
		if (
			api.getPanel(previous.id)?.api.component !== "launcher" ||
			api.getPanel(sibling.id) !== sibling ||
			JSON.stringify(api.toJSON()) !== JSON.stringify(before)
		)
			throw new Error(
				"complete layout restore did not restore the prior content",
			);
		const restored = api.getPanel(previous.id);
		delete before.panels[previous.id].tabComponent;
		api.fromJSON(before, { reuseExistingPanels: true });
		if (
			api.getPanel(previous.id) !== restored ||
			api.getPanel(sibling.id) !== sibling
		)
			throw new Error("default tab omission recreated unchanged content");
	} finally {
		api.dispose();
		element.remove();
	}
}
