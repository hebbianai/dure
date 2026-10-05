// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { movePaneToSpace } from "@/lib/workspace/dock";
import {
	registerDockview,
	unregisterDockview,
} from "@/lib/workspace/dock/dockRegistry";
import { useStore } from "@/store";
import { createDockviewGridRow } from "@/test/dockviewGridRow";

const previous = useStore.getState();
const disposers: (() => void)[] = [];
afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
	useStore.setState(previous);
});

function fixture() {
	const source = createDockviewGridRow([
		"source-first",
		"moving",
		"source-last",
	]);
	const target = createDockviewGridRow(["target-first", "target-last"]);
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
	const binding = {
		schemaVersion: 1,
		runtime: "hmux_managed_v1",
		source: "ssh",
		hostId: "remote",
		sessionId: "running",
		workspaceId: "remote-workspace",
	};
	source.api
		.getPanel("moving")!
		.api.updateParameters({ binding, agentId: "agent-codex" });
	useStore.setState({
		spaces: [
			{ id: "source", name: "Source" },
			{ id: "target", name: "Target" },
		],
		activeSpaceId: "source",
		layouts: {},
	});
	return { source, target, binding };
}

it("moves the exact pane once, preserves remote content and both surviving active panes", async () => {
	const { source, target, binding } = fixture();
	source.api.getPanel("source-last")!.api.setActive();
	target.api.getPanel("target-first")!.api.setActive();
	expect(await movePaneToSpace("moving", "source", "target")).toMatchObject({
		moved: true,
	});
	expect(await movePaneToSpace("moving", "source", "target")).toMatchObject({
		moved: false,
	});
	expect(source.api.getPanel("moving")).toBeUndefined();
	expect(target.api.panels.filter((pane) => pane.id === "moving")).toHaveLength(
		1,
	);
	expect(target.api.getPanel("moving")!.params).toEqual({
		binding,
		agentId: "agent-codex",
	});
	expect(useStore.getState().activeSpaceId).toBe("source");
	expect(source.api.activePanel?.id).toBe("source-last");
	expect(target.api.activePanel?.id).toBe("target-first");
});

it("refuses missing identities without writing or removing the source", async () => {
	const { source } = fixture();
	await expect(
		movePaneToSpace("moving", "source", "deleted"),
	).rejects.toMatchObject({ code: "space_not_found" });
	await expect(
		movePaneToSpace("absent", "source", "target"),
	).rejects.toMatchObject({ code: "pane_not_found" });
	expect(source.api.getPanel("moving")).toBeDefined();
	expect(useStore.getState().layouts).toEqual({});
});

it("moves to a cold Space without mounting or selecting it", async () => {
	const { source, target, binding } = fixture();
	useStore.getState().saveLayout("target", target.api.toJSON());
	unregisterDockview("target", target.api);
	await movePaneToSpace("moving", "source", "target");
	expect(source.api.getPanel("moving")).toBeUndefined();
	expect(useStore.getState().activeSpaceId).toBe("source");
	expect(useStore.getState().layouts.target).toMatchObject({
		panels: { moving: { params: { binding } } },
	});
});
