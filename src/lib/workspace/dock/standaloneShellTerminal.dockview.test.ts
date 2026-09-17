// @vitest-environment jsdom
import { createDockview } from "dockview-react";
import { afterEach, expect, it } from "vitest";
import { hmuxStandaloneBinding } from "@/lib/terminal/terminalBinding";
import { openHmuxStandaloneTerminalOn } from "./standaloneShellTerminal";

const disposals: Array<() => void> = [];
afterEach(() => {
	for (const dispose of disposals.splice(0)) dispose();
});

function setup() {
	const element = document.createElement("div");
	document.body.append(element);
	const api = createDockview(element, {
		createComponent: () => ({
			element: document.createElement("div"),
			init() {},
		}),
	});
	api.layout(1000, 700);
	disposals.push(() => {
		api.dispose();
		element.remove();
	});
	return api;
}

it.each(["slot", "launcher:previous", "agent:previous"])(
	"replays terminal presentation in %s without creating a second pane",
	(id) => {
		const api = setup();
		const slot = api.addPanel({ id, component: "launcher" });
		const sibling = api.addPanel({
			id: "sibling",
			component: "terminal",
			params: { sessionId: "keep-runtime" },
			position: { referencePanel: id, direction: "right" },
		});
		slot.api.setActive();
		const position = { replacement: slot.api };
		expect(
			openHmuxStandaloneTerminalOn(
				api,
				"runtime",
				"workspace",
				"/repo",
				position,
			),
		).toMatchObject({ panel: { id }, paneOwnership: "pre_existing" });
		const current = api.getPanel(id)!;
		const before = api.toJSON();
		for (const placement of [position, undefined]) {
			expect(
				openHmuxStandaloneTerminalOn(
					api,
					"runtime",
					"workspace",
					"/repo",
					placement,
				),
			).toMatchObject({ panel: current, paneOwnership: "pre_existing" });
			expect(api.getPanel(id)).toBe(current);
			expect(api.panels).toHaveLength(2);
			expect(api.getPanel(sibling.id)).toBe(sibling);
			expect(api.toJSON()).toEqual(before);
		}
	},
);

it.each([
	{
		component: "agent",
		params: {
			sessionId: "runtime",
			binding: hmuxStandaloneBinding("runtime", "workspace"),
		},
	},
	{ component: "terminal", params: { sessionId: "runtime", binding: null } },
	{
		component: "terminal",
		params: {
			sessionId: "runtime",
			binding: hmuxStandaloneBinding("runtime", "other-workspace"),
		},
	},
])(
	"does not retarget or collide with an occupied historical ID with $component / $params",
	(content) => {
		const api = setup();
		const pane = api.addPanel<Record<string, unknown>>({
			id: "term:runtime",
			...content,
		});
		const before = api.toJSON();
		const opened = openHmuxStandaloneTerminalOn(
			api,
			"runtime",
			"workspace",
			"/repo",
		);
		expect(opened.panel.id).not.toBe(pane.id);
		expect(opened.panel.params?.binding).toEqual(
			hmuxStandaloneBinding("runtime", "workspace"),
		);
		expect(opened.paneOwnership).toBe("created_by_request");
		expect(api.getPanel(pane.id)).toBe(pane);
		expect(api.toJSON().panels).toMatchObject(before.panels);
	},
);

it("allocates independent pane IDs for the same session spelling in different workspaces", () => {
	const api = setup();
	const first = openHmuxStandaloneTerminalOn(
		api,
		"runtime",
		"workspace-a",
		"/repo",
	);
	const second = openHmuxStandaloneTerminalOn(
		api,
		"runtime",
		"workspace-b",
		"/repo",
	);
	expect(first.panel.id).not.toMatch(/^(agent|term|terminal|launcher):/);
	expect(second.panel.id).not.toBe(first.panel.id);
	expect(api.panels).toHaveLength(2);
	for (const [workspace, expected] of [
		["workspace-a", first],
		["workspace-b", second],
	] as const) {
		expect(
			openHmuxStandaloneTerminalOn(api, "runtime", workspace, "/repo").panel,
		).toBe(expected.panel);
	}
});

it("does not replace newer content with a late terminal result", () => {
	const api = setup();
	const slot = api.addPanel({ id: "slot", component: "launcher" });
	const position = { replacement: slot.api };
	openHmuxStandaloneTerminalOn(api, "first", "workspace", "/repo", position);
	const before = api.toJSON();
	expect(() =>
		openHmuxStandaloneTerminalOn(api, "late", "workspace", "/repo", position),
	).toThrow();
	expect(api.toJSON()).toEqual(before);
});
