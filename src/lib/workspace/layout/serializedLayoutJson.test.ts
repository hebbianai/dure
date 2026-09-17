import { describe, expect, it } from "vitest";
import {
	cloneJson,
	recordOf,
	replacePanelReferences,
} from "@/lib/workspace/layout/serializedLayoutJson";

describe("recordOf", () => {
	it("narrows plain objects and rejects arrays and primitives", () => {
		const record = { a: 1 };
		expect(recordOf(record)).toBe(record);
		expect(recordOf([1, 2])).toBeNull();
		expect(recordOf("x")).toBeNull();
		expect(recordOf(null)).toBeNull();
		expect(recordOf(undefined)).toBeNull();
	});
});

describe("cloneJson", () => {
	it("returns an independent deep copy", () => {
		const source = { grid: { root: { data: [{ views: ["a"] }] } } };
		const clone = cloneJson(source);
		expect(clone).toEqual(source);
		expect(clone).not.toBe(source);
		expect(clone?.grid.root.data[0]).not.toBe(source.grid.root.data[0]);
	});

	it("returns null when the value cannot round-trip", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(cloneJson(cyclic)).toBeNull();
	});
});

describe("replacePanelReferences", () => {
	it("rewrites views, panelIds, and activeView across nested branches", () => {
		const layout = {
			grid: {
				root: {
					type: "branch",
					data: [
						{
							type: "leaf",
							data: {
								id: "group-1",
								views: ["term:1", "other"],
								activeView: "term:1",
								tabGroups: [{ panelIds: ["term:1"] }],
							},
						},
					],
				},
			},
		};
		replacePanelReferences(layout, "term:1", "agent:1");
		const group = layout.grid.root.data[0].data;
		expect(group.views).toEqual(["agent:1", "other"]);
		expect(group.activeView).toBe("agent:1");
		expect(group.tabGroups[0].panelIds).toEqual(["agent:1"]);
	});

	it("leaves unrelated references and non-matching activeView untouched", () => {
		const layout = {
			title: "term:1",
			data: { views: ["other"], activeView: "other" },
		};
		replacePanelReferences(layout, "term:1", "agent:1");
		expect(layout.title).toBe("term:1");
		expect(layout.data.views).toEqual(["other"]);
		expect(layout.data.activeView).toBe("other");
	});
});
