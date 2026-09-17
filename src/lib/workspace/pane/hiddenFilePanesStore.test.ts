import { describe, expect, it } from "vitest";
import { normalizeHiddenFilePanes } from "@/lib/workspace/pane/hiddenFilePanesStore";

describe("normalizeHiddenFilePanes", () => {
	it("preserves opaque and historical pane IDs with explicit file coordinates", () => {
		expect(
			normalizeHiddenFilePanes({
				"file:local::/a.png": {
					desktopId: "desk-1",
					at: 5,
					file: { path: "/a.png", source: "local" },
					anchor: { floating: { x: 1, y: 2, width: 300, height: 200 } },
				},
				"file:ssh:h1:/b.ts": {
					desktopId: "desk-1",
					at: 6,
					file: { path: "/b.ts", source: "ssh", hostId: "h1" },
				},
				"agent:x": { desktopId: "desk-1", at: 7, file: { path: "/c", source: "local" } },
				"pane-view": { desktopId: "desk-2", at: 7, file: { path: "/c", source: "local" } },
				"file:bad": { desktopId: "desk-1", at: 8, file: { path: "", source: "local" } },
				"file:bad2": { desktopId: "desk-1", at: 9, file: { path: "/d", source: "ftp" } },
				"file:bad3": { desktopId: "desk-1", at: 10 },
			}),
		).toEqual({
			"file:local::/a.png": {
				desktopId: "desk-1",
				at: 5,
				file: { path: "/a.png", source: "local" },
				anchor: { floating: { x: 1, y: 2, width: 300, height: 200 } },
			},
			"file:ssh:h1:/b.ts": {
				desktopId: "desk-1",
				at: 6,
				file: { path: "/b.ts", source: "ssh", hostId: "h1" },
			},
			"agent:x": { desktopId: "desk-1", at: 7, file: { path: "/c", source: "local" } },
			"pane-view": { desktopId: "desk-2", at: 7, file: { path: "/c", source: "local" } },
		});
		expect(normalizeHiddenFilePanes(null)).toEqual({});
		expect(normalizeHiddenFilePanes([1])).toEqual({});
	});

	it("does not turn malformed explicit coordinates into another file target", () => {
		const record = { desktopId: "desk", at: 1, file: { path: "/a", source: "ssh", hostId: 7 } };
		expect(normalizeHiddenFilePanes({ "file:legacy": record })).toEqual({});
	});

	it("retains long historical IDs and prototype-shaped opaque IDs as own keys", () => {
		const record = { desktopId: "desk", at: 1, file: { path: "/a", source: "local" } };
		const longId = `file:local::/${"a/".repeat(300)}file.txt`;
		const entries = [[longId, record], ["__proto__", record]] as const;
		const result = normalizeHiddenFilePanes(Object.fromEntries(entries));
		expect(Object.entries(result)).toEqual(entries);
		expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
	});
});
