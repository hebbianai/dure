// @vitest-environment jsdom
import { createDockview } from "dockview-react";
import { afterEach, describe, expect, it } from "vitest";
import {
	hmuxLocalBinding,
	hmuxManagedBinding,
} from "@/lib/terminal/terminalBinding";
import {
	openHmuxManagedTerminalPanel,
	openHmuxTerminalPanel,
} from "@/lib/workspace/dock";
import { registerDockview, unregisterDockview } from "./dockRegistry";

const disposals: (() => void)[] = [];
let sequence = 0;
afterEach(() => {
	for (const dispose of disposals.splice(0)) dispose();
});

function setup() {
	const desktopId = `terminal-receipt-${++sequence}`;
	const element = document.createElement("div");
	document.body.append(element);
	const api = createDockview(element, {
		createComponent: () => ({
			element: document.createElement("div"),
			init() {},
		}),
	});
	api.layout(1000, 700);
	registerDockview(desktopId, api);
	disposals.push(() => {
		unregisterDockview(desktopId, api);
		api.dispose();
		element.remove();
	});
	return { api, desktopId };
}

describe.each([
	{
		kind: "managed",
		binding: hmuxManagedBinding,
		open: openHmuxManagedTerminalPanel,
	},
	{ kind: "observer", binding: hmuxLocalBinding, open: openHmuxTerminalPanel },
])("$kind terminal presentation", ({ binding, open }) => {
	it("allocates independent pane IDs for the same session spelling in different workspaces", () => {
		const { api, desktopId } = setup();
		const first = open(desktopId, "runtime", "workspace-a", "/repo");
		const second = open(desktopId, "runtime", "workspace-b", "/repo");
		expect(first).not.toMatch(/^(agent|term|terminal|launcher):/);
		expect(second).not.toBe(first);
		expect(api.panels).toHaveLength(2);
		for (const [workspace, panelId] of [
			["workspace-a", first],
			["workspace-b", second],
		] as const) {
			expect(open(desktopId, "runtime", workspace, "/repo")).toBe(panelId);
			expect(api.getPanel(String(panelId))?.params?.binding).toEqual(
				binding("runtime", workspace),
			);
		}
	});

	it.each(["slot", "launcher:previous", "agent:previous"])(
		"reuses and reports the actual current target in %s",
		(id) => {
			const { api, desktopId } = setup();
			const source = api.addPanel({
				id,
				component: "terminal",
				params: {
					sessionId: "runtime",
					binding: binding("runtime", "workspace"),
				},
			});
			const peer = api.addPanel({ id: "peer", component: "launcher" });
			for (let replay = 0; replay < 2; replay += 1) {
				expect(open(desktopId, "runtime", "workspace", "/repo")).toBe(id);
				expect(api.getPanel(id)).toBe(source);
				expect(api.getPanel(peer.id)).toBe(peer);
				expect(api.panels).toHaveLength(2);
			}
		},
	);

	it("reports the same slot after explicit content replacement and replay", () => {
		const { api, desktopId } = setup();
		const slot = api.addPanel({ id: "slot", component: "launcher" });
		const position = { replacement: slot.api };
		expect(open(desktopId, "runtime", "workspace", "/repo", position)).toBe(
			slot.id,
		);
		const terminal = api.getPanel(slot.id)!;
		expect(terminal.api.component).toBe("terminal");
		expect(open(desktopId, "runtime", "workspace", "/repo", position)).toBe(
			slot.id,
		);
		expect(api.panels).toEqual([terminal]);
	});
});
