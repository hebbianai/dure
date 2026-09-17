import { describe, expect, it } from "vitest";
import {
	createPaneTransferPayload,
	type LabeledScreenRect,
	PANE_TRANSFER_MIME,
	PANE_WINDOW_DROP_EVENT,
	paneDragReleaseTarget,
	parsePaneTransferPayload,
	resolvePaneDropPosition,
	serializePaneTransferPayload,
} from "@/lib/workspace/pane/paneWindowTransfer";

describe("pane window transfer payload", () => {
	it("publishes only canonical Dure transport names", () => {
		expect(PANE_TRANSFER_MIME).toBe("application/x-dure-pane");
		expect(PANE_WINDOW_DROP_EVENT).toBe("dure:pane-window-drop-v1");
	});

	it("round-trips a bounded pane identity without pane params or session secrets", () => {
		const payload = createPaneTransferPayload(
			{
				panelId: "term:session-1",
				fromDesktopId: "desk-source",
				sourceWindowLabel: "main",
			},
			"request-1",
		);

		expect(
			parsePaneTransferPayload(serializePaneTransferPayload(payload)),
		).toEqual(payload);
		expect(payload).toEqual({
			schemaVersion: 1,
			requestId: "request-1",
			panelId: "term:session-1",
			fromDesktopId: "desk-source",
			sourceWindowLabel: "main",
		});
	});

	it("rejects malformed, oversized, and unknown-version payloads", () => {
		expect(parsePaneTransferPayload("not-json")).toBeNull();
		expect(
			parsePaneTransferPayload(
				JSON.stringify({
					schemaVersion: 2,
					requestId: "request-1",
					panelId: "term:session-1",
					fromDesktopId: "desk-source",
					sourceWindowLabel: "main",
				}),
			),
		).toBeNull();
		expect(
			parsePaneTransferPayload(
				JSON.stringify({
					schemaVersion: 1,
					requestId: "request-1",
					panelId: `term:${"x".repeat(600)}`,
					fromDesktopId: "desk-source",
					sourceWindowLabel: "main",
				}),
			),
		).toBeNull();
	});
});

describe("pane drag release routing", () => {
	const windows: LabeledScreenRect[] = [
		{
			label: "main",
			x: 100,
			y: 100,
			width: 900,
			height: 700,
			workspace: true,
		},
		{
			label: "win-123-0",
			x: 1100,
			y: 100,
			width: 700,
			height: 600,
			workspace: true,
		},
		{
			label: "win-diff-agent",
			x: 1100,
			y: 750,
			width: 700,
			height: 400,
			workspace: false,
		},
	];

	it("routes a release over another workspace window to that exact label", () => {
		expect(paneDragReleaseTarget({ x: 1300, y: 300 }, "main", windows)).toEqual(
			{ kind: "workspace", windowLabel: "win-123-0" },
		);
	});

	it("does not move or tear out over the source or a utility window", () => {
		expect(paneDragReleaseTarget({ x: 400, y: 300 }, "main", windows)).toEqual({
			kind: "blocked",
		});
		expect(paneDragReleaseTarget({ x: 1300, y: 900 }, "main", windows)).toEqual(
			{ kind: "blocked" },
		);
	});

	it("does not route to a workspace hidden behind the focused source window", () => {
		expect(
			paneDragReleaseTarget({ x: 400, y: 300 }, "main", [
				{ ...windows[0], focused: true },
				{ ...windows[1], x: 300, y: 200 },
			]),
		).toEqual({ kind: "blocked" });
	});

	it("distinguishes outside-all-windows from an unavailable window census", () => {
		expect(paneDragReleaseTarget({ x: 50, y: 50 }, "main", windows)).toEqual({
			kind: "outside",
		});
		expect(paneDragReleaseTarget({ x: 50, y: 50 }, "main", [])).toEqual({
			kind: "unknown",
		});
	});
});

describe("resolvePaneDropPosition", () => {
	const dock = { x: 50, y: 40, width: 1000, height: 700 };
	const group = {
		value: "group-1",
		bounds: { x: 100, y: 100, width: 500, height: 400 },
	};

	it("resolves root and group edge drops in target-window coordinates", () => {
		expect(resolvePaneDropPosition({ x: 55, y: 300 }, dock, [group])).toEqual({
			direction: "left",
		});
		expect(resolvePaneDropPosition({ x: 350, y: 105 }, dock, [group])).toEqual({
			referenceGroup: "group-1",
			direction: "above",
		});
		expect(resolvePaneDropPosition({ x: 595, y: 300 }, dock, [group])).toEqual({
			referenceGroup: "group-1",
			direction: "right",
		});
	});

	it("fails closed outside the dock or in a pane center where stacking is forbidden", () => {
		expect(resolvePaneDropPosition({ x: 20, y: 20 }, dock, [group])).toBeNull();
		expect(
			resolvePaneDropPosition({ x: 350, y: 300 }, dock, [group]),
		).toBeNull();
	});
});
