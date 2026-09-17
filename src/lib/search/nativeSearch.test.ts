import { describe, expect, it } from "vitest";
import {
	type NativeSearchItem,
	nativeSearchStatus,
	parseNativeSearchQuery,
	rankNativeSearchItems,
} from "@/lib/search/nativeSearch";

function item(
	id: string,
	kind: NativeSearchItem["kind"],
	title: string,
	detail = "",
): NativeSearchItem {
	return {
		id,
		kind,
		title,
		detail,
		action: { type: "app-command", command: "open-settings" },
	};
}

describe("parseNativeSearchQuery", () => {
	it("maps compact scope prefixes without making plain searches scoped", () => {
		expect([...parseNativeSearchQuery("@ codex").kinds]).toEqual([
			"agent",
			"session",
		]);
		expect([...parseNativeSearchQuery("/src/app").kinds]).toEqual(["file"]);
		expect([...parseNativeSearchQuery("> git status").kinds]).toEqual([
			"command",
		]);
		expect([...parseNativeSearchQuery("# main").kinds]).toEqual([
			"worktree",
			"repository",
		]);
		expect(parseNativeSearchQuery("readme").kinds.size).toBe(6);
	});
});

describe("rankNativeSearchItems", () => {
	const items = [
		item("substring", "file", "src/nativeSearch.ts"),
		item("exact", "agent", "search"),
		item("detail", "worktree", "feature", "search worktree"),
		item("fuzzy", "repository", "source-archive"),
	];

	it("orders exact title, title substring, detail, then subsequence matches", () => {
		expect(rankNativeSearchItems(items, "search").map(({ id }) => id)).toEqual([
			"exact",
			"substring",
			"detail",
			"fuzzy",
		]);
	});

	it("requires every token but allows tokens to match different fields", () => {
		const result = rankNativeSearchItems(
			[
				item("hit", "agent", "Codex", "native search"),
				item("miss", "agent", "Codex"),
			],
			"codex native",
		);
		expect(result.map(({ id }) => id)).toEqual(["hit"]);
	});

	it("honors scopes, limits, stable ordering, and live-status boosts", () => {
		const candidates: NativeSearchItem[] = [
			{ ...item("idle", "agent", "same"), status: "exited" },
			{ ...item("live", "agent", "same"), status: "working" },
			item("file", "file", "same"),
		];
		expect(
			rankNativeSearchItems(candidates, "@ same", 2).map(({ id }) => id),
		).toEqual(["live", "idle"]);
		expect(
			rankNativeSearchItems(candidates, "/", 1).map(({ id }) => id),
		).toEqual(["file"]);
	});
});

describe("nativeSearchStatus", () => {
	it("normalizes transport liveness without guessing absent state", () => {
		expect(nativeSearchStatus("working")).toBe("working");
		expect(nativeSearchStatus("reconnecting")).toBe("connecting");
		expect(nativeSearchStatus("done")).toBe("done");
		expect(nativeSearchStatus("error")).toBe("exited");
		expect(nativeSearchStatus(undefined)).toBeUndefined();
	});
});
