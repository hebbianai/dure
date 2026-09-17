import { describe, expect, it } from "vitest";
import {
	migrateCollapsedGroups,
	normalizeCollapsedKeys,
	setCollapsedKeys,
	toggleCollapsedKey,
} from "@/lib/spaces/spacesCollapsedGroupsStore";

describe("toggleCollapsedKey", () => {
	it("folds an open group and unfolds a folded one", () => {
		const folded = toggleCollapsedKey({}, '["project","p1"]');
		expect(folded).toEqual({ '["project","p1"]': true });
		expect(toggleCollapsedKey(folded, '["project","p1"]')).toEqual({});
	});

	it("leaves other groups untouched", () => {
		const state = { a: true as const };
		expect(toggleCollapsedKey(state, "b")).toEqual({ a: true, b: true });
		expect(toggleCollapsedKey({ a: true, b: true }, "a")).toEqual({ b: true });
	});
});

describe("setCollapsedKeys", () => {
	it("folds and unfolds only the rendered keys", () => {
		const folded = setCollapsedKeys({ hidden: true }, ["a", "b"], true);
		expect(folded).toEqual({ hidden: true, a: true, b: true });
		expect(setCollapsedKeys(folded, ["a", "b"], false)).toEqual({
			hidden: true,
		});
	});

	it("preserves object identity when the requested state is already true", () => {
		const folded = { a: true as const };
		expect(setCollapsedKeys(folded, ["a"], true)).toBe(folded);
		expect(setCollapsedKeys(folded, [], false)).toBe(folded);
	});
});

describe("normalizeCollapsedKeys", () => {
	it("keeps only entries that are literally true", () => {
		expect(
			normalizeCollapsedKeys({
				collapsed: { keep: true, drop: false, junk: "yes", nil: null },
			}),
		).toEqual({ keep: true });
	});

	it("starts every group open for a missing or malformed snapshot", () => {
		expect(normalizeCollapsedKeys(undefined)).toEqual({});
		expect(normalizeCollapsedKeys({ collapsed: 3 })).toEqual({});
		expect(normalizeCollapsedKeys("nope")).toEqual({});
	});
});

describe("migrateCollapsedGroups", () => {
	it("folds the unopened section once for snapshots from before it folded by default", () => {
		expect(migrateCollapsedGroups({ collapsed: { a: true } }, 1)).toEqual({
			collapsed: { a: true, unopened: true },
		});
		expect(migrateCollapsedGroups({ collapsed: {} }, 1)).toEqual({
			collapsed: { unopened: true },
		});
	});

	it("leaves a current snapshot alone — an opened section stays open", () => {
		const current = { collapsed: { a: true } };
		expect(migrateCollapsedGroups(current, 2)).toBe(current);
	});
});
