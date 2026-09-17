import { describe, expect, it } from "vitest";
import { planSpacesPaneDrop } from "@/lib/sidebar/spacesPaneDrop";

describe("planSpacesPaneDrop", () => {
	it("keeps an exact same-desktop drop as a reorder instead of discarding it", () => {
		expect(
			planSpacesPaneDrop(
				[{ panelId: "agent:a", fromDesktopId: "desktop-1" }],
				"desktop-1",
				{ referenceGroup: { id: "group-b" }, direction: "left" },
			),
		).toEqual({
			kind: "reorder",
			item: { panelId: "agent:a", fromDesktopId: "desktop-1" },
			position: { referenceGroup: { id: "group-b" }, direction: "left" },
		});
	});

	it("uses the target-first exact transaction across spaces", () => {
		expect(
			planSpacesPaneDrop(
				[{ panelId: "agent:a", fromDesktopId: "desktop-1" }],
				"desktop-2",
				{ referenceGroup: "group-b", direction: "below" },
			),
		).toEqual({
			kind: "exact-transfer",
			item: { panelId: "agent:a", fromDesktopId: "desktop-1" },
			position: { referenceGroup: "group-b", direction: "below" },
		});
	});

	it("preserves bulk movement while removing panes already on the target", () => {
		expect(
			planSpacesPaneDrop(
				[
					{ panelId: "agent:a", fromDesktopId: "desktop-1" },
					{ panelId: "agent:b", fromDesktopId: "desktop-2" },
				],
				"desktop-2",
				{ direction: "right" },
			),
		).toEqual({
			kind: "bulk-transfer",
			items: [{ panelId: "agent:a", fromDesktopId: "desktop-1" }],
		});
	});

	it("treats an imprecise same-desktop release as a no-op", () => {
		expect(
			planSpacesPaneDrop(
				[{ panelId: "agent:a", fromDesktopId: "desktop-1" }],
				"desktop-1",
				{},
			),
		).toEqual({ kind: "noop" });
	});

	it("rejects malformed and duplicate item identities", () => {
		expect(
			planSpacesPaneDrop(
				[
					{ panelId: "", fromDesktopId: "desktop-1" },
					{ panelId: "agent:a", fromDesktopId: "desktop-1" },
					{ panelId: "agent:a", fromDesktopId: "desktop-1" },
				],
				"desktop-2",
				{},
			),
		).toEqual({
			kind: "bulk-transfer",
			items: [{ panelId: "agent:a", fromDesktopId: "desktop-1" }],
		});
	});
});
