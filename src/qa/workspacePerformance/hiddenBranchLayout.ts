import { createDockview } from "dockview-react";

/** Exercise the dependency's restore/move transition inside the native WebView
 * before the real-input sash phase. No provider sessions or durable layout are
 * created: these four views belong only to this disposable fixture. */
export function assertHiddenBranchLayout(
	doc: Document,
	create = createDockview,
): void {
	const container = doc.createElement("div");
	doc.body.append(container);
	const api = create(container, {
		createComponent: () => ({ element: doc.createElement("div"), init() {} }),
	});
	try {
		api.addPanel({ id: "top", component: "test" });
		api.addPanel({
			id: "bottom",
			component: "test",
			position: { referencePanel: "top", direction: "below" },
		});
		api.addPanel({
			id: "hidden-top",
			component: "test",
			position: { referencePanel: "top", direction: "right" },
		});
		api.addPanel({
			id: "hidden-bottom",
			component: "test",
			position: { referencePanel: "hidden-top", direction: "below" },
		});
		api.layout(1_000, 700);
		api.getPanel("hidden-top")!.group.api.setVisible(false);
		api.getPanel("hidden-bottom")!.group.api.setVisible(false);
		const height = api.getPanel("top")!.group.api.height;
		api.fromJSON(api.toJSON());
		if (api.getPanel("top")!.group.api.height !== height) {
			throw new Error("hidden branch restore collapsed a visible row");
		}
		api.getPanel("top")!.group.api.setSize({ height: height + 70 });
		if (api.getPanel("top")!.group.api.height !== height + 70) {
			throw new Error("hidden branch restore locked the sash");
		}
		api
			.getPanel("top")!
			.api.moveTo({ group: api.getPanel("bottom")!.group, position: "right" });
		for (const id of ["top", "bottom"]) {
			if (api.getPanel(id)!.group.api.height !== 700) {
				throw new Error("hidden branch promotion retained a blank row");
			}
		}
	} finally {
		api.dispose();
		container.remove();
	}
}
