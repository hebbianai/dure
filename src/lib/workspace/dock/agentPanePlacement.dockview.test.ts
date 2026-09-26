// @vitest-environment jsdom
import { createDockview, type DockviewApi } from "dockview-react";
import { afterEach, expect, it } from "vitest";
import {
	registerDockview,
	unregisterDockview,
} from "@/lib/workspace/dock/dockRegistry";
import { openAgentPanelOnDockview } from "@/lib/workspace/dock/openAgentPanel";
import { useStore } from "@/store";
import { agentFixture } from "@/test/agentFixtures";

const disposers: (() => void)[] = [];
const initial = useStore.getState();
afterEach(() => {
	for (const dispose of disposers.splice(0).reverse()) dispose();
	useStore.setState(initial, true);
});
function fixture(width = 1600, height = 900) {
	const element = document.createElement("div");
	document.body.append(element);
	const api = createDockview(element, {
		createComponent: () => ({
			element: document.createElement("textarea"),
			init() {},
		}),
	});
	const desktopId = `agent-placement-${disposers.length}`;
	registerDockview(desktopId, api);
	api.layout(width, height);
	disposers.push(() => {
		unregisterDockview(desktopId, api);
		api.dispose();
		element.remove();
	});
	const add = (
		id: string,
		preferredPanelId?: string,
		position?: Parameters<typeof openAgentPanelOnDockview>[0]["position"],
	) => {
		const panelId = openAgentPanelOnDockview({
			api,
			desktopId,
			agent: agentFixture({ id }),
			position,
			preferredPanelId,
		});
		expect(panelId).not.toBe(false);
		return api.getPanel(String(panelId))!;
	};
	return { api, desktopId, add };
}

it("fills four readable tiles instead of four narrow columns, preserving existing content", () => {
	const { api, desktopId, add } = fixture();
	const first = add("first");
	const element = first.group.element;
	const input = element.querySelector("textarea")!;
	input.value = "keep draft";
	for (const id of ["second", "third", "fourth"]) add(id);
	expect(api.groups).toHaveLength(4);
	for (const group of api.groups) {
		expect(group.api.width).toBeCloseTo(800, 0);
		expect(group.api.height).toBeCloseTo(450, 0);
		expect(group.panels).toHaveLength(1);
	}
	expect(api.getPanel(first.id)).toBe(first);
	expect(first.group.element).toBe(element);
	expect(input.value).toBe("keep draft");
	const saved = useStore.getState().layouts[desktopId] as ReturnType<
		DockviewApi["toJSON"]
	>;
	expect(saved.grid).toEqual(api.toJSON().grid);
	const restored = fixture().api;
	restored.fromJSON(saved);
	expect(
		restored.groups.map((group) => [group.api.width, group.api.height]),
	).toEqual(api.groups.map((group) => [group.api.width, group.api.height]));
});

it("uses the invoking pane instead of the active one, then another fitting group", () => {
	const { api, add } = fixture();
	const parent = add("parent");
	const other = add("other");
	const child = add("child", parent.id);
	expect(other.group.api.height).toBeCloseTo(900, 0);
	expect(parent.group.api.height).toBeCloseTo(450, 0);
	expect(child.group.api.height).toBeCloseTo(450, 0);
	add("next-child", parent.id);
	expect(
		api.groups.every(
			(group) => group.api.width >= 480 && group.api.height >= 300,
		),
	).toBe(true);
	expect(other.group.api.height).toBeCloseTo(450, 0);
});

it("preserves an explicit direction even when automatic placement would use another axis", () => {
	const { api, add } = fixture();
	const parent = add("parent");
	const child = add("child", undefined, {
		referencePanel: parent.id,
		direction: "below",
	});
	expect(child.group.api.width).toBeCloseTo(1600, 0);
	expect(child.group.api.height).toBeCloseTo(450, 0);
	expect(api.groups).toHaveLength(2);
});
