// @vitest-environment jsdom
import { createDockview } from "dockview-react";
import { describe, expect, it } from "vitest";
import { buildDureClientPresentation } from "@/lib/persistence/dureClientPresentation";
import { hmuxStandaloneBinding } from "@/lib/terminal/terminalBinding";
import { normalizePersistedPaneLayout } from "./persistedPaneLayout";
import { terminalPanesFromLayout } from "./terminalSessionRefs";

describe("pane content through actual Dockview serialization", () => {
	it.each(["agent:previous", "launcher:previous", "pane:opaque"])(
		"restores %s without relabeling it or losing its target",
		(paneId) => {
			const container = document.createElement("div");
			document.body.append(container);
			const api = createDockview(container, {
				createComponent: () => ({
					element: document.createElement("div"),
					init() {},
				}),
			});
			try {
				api.layout(1000, 700);
				const binding = hmuxStandaloneBinding("current-session", "workspace-1");
				api.addPanel({
					id: paneId,
					component: "terminal",
					params: { sessionId: binding.sessionId, binding },
				});
				api.addPanel({
					id: "term:selector",
					component: "launcher",
					params: { cwd: "/chosen" },
					position: { referencePanel: paneId, direction: "right" },
				});
				const saved = api.toJSON();
				const restored = normalizePersistedPaneLayout(
					JSON.parse(JSON.stringify(saved)),
				);
				api.fromJSON(restored as ReturnType<typeof api.toJSON>);
				expect(api.panels.map((panel) => panel.id)).toEqual([
					paneId,
					"term:selector",
				]);
				expect(api.getPanel(paneId)?.params).toEqual({
					sessionId: binding.sessionId,
					binding,
				});
				expect(api.getPanel(paneId)?.api.component).toBe("terminal");
				expect(api.getPanel("term:selector")?.api.component).toBe("launcher");
				expect(api.toJSON().grid).toEqual(saved.grid);
				expect(terminalPanesFromLayout(api.toJSON())).toEqual([
					{
						panelId: paneId,
						kind: "pty",
						sessionId: binding.sessionId,
						persistent: true,
					},
				]);
				const projection = buildDureClientPresentation({
					spaces: [{ id: "space-1", name: "Work" }],
					layouts: { "space-1": api.toJSON() },
					agents: [],
				});
				expect(projection.spaces[0].panes).toMatchObject([
					{
						id: paneId,
						component: "terminal",
						type: "terminal",
						agentId: null,
						binding: { sessionId: binding.sessionId },
					},
					{
						id: "term:selector",
						component: "launcher",
						type: "other",
						agentId: null,
						binding: null,
					},
				]);
			} finally {
				api.dispose();
				container.remove();
			}
		},
	);
});
