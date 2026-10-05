// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import {
	beginSpacesRowDrag,
	endSpacesRowDrag,
	spacesDragPayload,
} from "@/lib/spaces/spacesDrag";
import {
	canDropPaneOnSpace,
	dropPanesOnSpace,
} from "@/lib/spaces/spacesPaneTabDrop";
import {
	registerDockview,
	unregisterDockview,
} from "@/lib/workspace/dock/dockRegistry";
import { setDragState } from "@/lib/workspace/pane/paneDragState";
import { useStore } from "@/store";
import { createDockviewGridRow } from "@/test/dockviewGridRow";

const previous = useStore.getState();
const disposers: (() => void)[] = [];
afterEach(() => {
	endSpacesRowDrag();
	for (const dispose of disposers.splice(0)) dispose();
	useStore.setState(previous);
});
function fixture() {
	const source = createDockviewGridRow(["first", "second"]);
	const target = createDockviewGridRow(["target"]);
	for (const [id, row] of [
		["source", source],
		["target", target],
	] as const) {
		registerDockview(id, row.api);
		disposers.push(() => {
			unregisterDockview(id, row.api);
			row.dispose();
		});
	}
	useStore.setState({
		layouts: {},
		spaces: [
			{ id: "source", name: "Source" },
			{ id: "target", name: "Target" },
		],
		activeSpaceId: "source",
	});
	return { source, target };
}
it("moves every selected pane using the drop payload after capture cleared module hints", async () => {
	const { source, target } = fixture();
	const items = ["first", "second"].map((panelId) => ({
		panelId,
		fromDesktopId: "source",
	}));
	beginSpacesRowDrag(items);
	expect(canDropPaneOnSpace("target")).toBe(true);
	const raw = spacesDragPayload(items);
	endSpacesRowDrag();
	expect(await dropPanesOnSpace({ getData: () => raw }, "target")).toBe(true);
	expect(source.api.panels).toHaveLength(0);
	expect(target.api.panels.map((pane) => pane.id).sort()).toEqual([
		"first",
		"second",
		"target",
	]);
	expect(useStore.getState().activeSpaceId).toBe("source");
});
it("does not spend a stale paired pane identity after rejecting an invalid row payload", async () => {
	const { source, target } = fixture();
	setDragState({ panelId: "first", fromDesktopId: "source" });
	expect(
		await dropPanesOnSpace({ getData: () => "dure:{invalid" }, "target"),
	).toBe(false);
	expect(source.api.panels).toHaveLength(2);
	expect(target.api.panels).toHaveLength(1);
	expect(canDropPaneOnSpace("target")).toBe(false);
});
it("keeps same-Space drops unchanged and supports native pane-tab hints", async () => {
	const { source, target } = fixture();
	setDragState({ panelId: "first", fromDesktopId: "source" });
	expect(canDropPaneOnSpace("source")).toBe(false);
	expect(await dropPanesOnSpace({ getData: () => "" }, "source")).toBe(false);
	setDragState({ panelId: "first", fromDesktopId: "source" });
	expect(await dropPanesOnSpace({ getData: () => "" }, "target")).toBe(true);
	expect(source.api.getPanel("first")).toBeUndefined();
	expect(target.api.getPanel("first")).toBeDefined();
});
