import { describe, expect, it } from "vitest";
import {
	normalizeHiddenPaneAnchor,
	normalizeHiddenPanes,
} from "@/lib/workspace/pane/hiddenPanesStore";

describe("normalizeHiddenPanes", () => {
	it("손상 저장분을 조용히 버린다", () => {
		expect(
			normalizeHiddenPanes({
				ok: { desktopId: "desk-1", at: 5 },
				noDesktop: { at: 5 },
				badAt: { desktopId: "desk-1", at: "x" },
				junk: null,
			}),
		).toEqual({ ok: { desktopId: "desk-1", paneId: "agent:ok", at: 5 } });
		expect(normalizeHiddenPanes(null)).toEqual({});
		expect(normalizeHiddenPanes([1, 2])).toEqual({});
	});
});

describe("normalizeHiddenPaneAnchor", () => {
	it("이웃/floating 두 변형을 받고 손상분은 버린다", () => {
		expect(
			normalizeHiddenPaneAnchor({ referencePanelId: "p", direction: "left" }),
		).toEqual({ referencePanelId: "p", direction: "left" });
		expect(
			normalizeHiddenPaneAnchor({
				floating: { x: 1, y: 2, width: 300, height: 200 },
			}),
		).toEqual({ floating: { x: 1, y: 2, width: 300, height: 200 } });
		expect(
			normalizeHiddenPaneAnchor({ floating: { x: 1, y: 2, width: "w" } }),
		).toBeUndefined();
		expect(
			normalizeHiddenPaneAnchor({ referencePanelId: "p", direction: "sideways" }),
		).toBeUndefined();
		expect(normalizeHiddenPaneAnchor("junk")).toBeUndefined();
	});
});
