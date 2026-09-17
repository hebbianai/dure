import { describe, expect, it } from "vitest";
import { pickDirectionalPane, visiblePaneFromLayout } from "@/lib/workspace/pane/paneFocusNavigation";

// 2×2 격자: a(좌상) b(우상) / c(좌하) d(우하)
const GRID = [
	{ id: "a", x: 0, y: 0, width: 100, height: 100 },
	{ id: "b", x: 100, y: 0, width: 100, height: 100 },
	{ id: "c", x: 0, y: 100, width: 100, height: 100 },
	{ id: "d", x: 100, y: 100, width: 100, height: 100 },
];

describe("pickDirectionalPane", () => {
	it("격자에서 네 방향 이동이 이웃을 고른다", () => {
		expect(pickDirectionalPane(GRID, "a", "right")).toBe("b");
		expect(pickDirectionalPane(GRID, "a", "down")).toBe("c");
		expect(pickDirectionalPane(GRID, "d", "left")).toBe("c");
		expect(pickDirectionalPane(GRID, "d", "up")).toBe("b");
	});

	it("방향에 아무것도 없으면 undefined — 경계에서 no-op", () => {
		expect(pickDirectionalPane(GRID, "a", "left")).toBeUndefined();
		expect(pickDirectionalPane(GRID, "b", "up")).toBeUndefined();
	});

	it("바로 옆이 대각선보다 먼저다 (수직 어긋남 벌점)", () => {
		// a에서 오른쪽: 같은 행의 b가 대각선의 d보다 우선
		expect(pickDirectionalPane(GRID, "a", "right")).toBe("b");
		// 세로 3분할 오른쪽 열에서 왼쪽으로: 높이가 겹치는 쪽 우선
		const rects = [
			{ id: "tall-left", x: 0, y: 0, width: 100, height: 300 },
			{ id: "right-top", x: 100, y: 0, width: 100, height: 100 },
			{ id: "right-bottom", x: 100, y: 200, width: 100, height: 100 },
		];
		expect(pickDirectionalPane(rects, "right-bottom", "left")).toBe("tall-left");
	});

	it("활성 그룹을 모르면 undefined", () => {
		expect(pickDirectionalPane(GRID, "ghost", "right")).toBeUndefined();
	});
});

describe("visiblePaneFromLayout", () => {
	const leaf = (id: string, visible = true) => ({
		type: "leaf", visible,
		data: { id, views: [`term:${id}`], activeView: `term:${id}` },
	});
	const layout = (data: unknown[], activeGroup: string) => ({
		activeGroup, grid: { root: { type: "branch", data } },
	});

	it("retains a valid selection and skips hidden leaves and entire hidden branches", () => {
		const tree = layout([
			leaf("hidden", false),
			{ type: "branch", visible: false, data: [leaf("hidden-child")] },
			leaf("first"), leaf("last"),
		], "last");
		expect(visiblePaneFromLayout(tree)).toBe("term:last");
		expect(visiblePaneFromLayout({ ...tree, activeGroup: "hidden" })).toBe("term:first");
		expect(visiblePaneFromLayout({ ...tree, activeGroup: "hidden-child" })).toBe("term:first");
	});

	it("uses a visible group's active tab and ignores stale activeView references", () => {
		const group = leaf("tabs");
		group.data.views.push("term:second-tab");
		group.data.activeView = "term:second-tab";
		expect(visiblePaneFromLayout(layout([group], "tabs"))).toBe("term:second-tab");
		group.data.activeView = "term:missing";
		expect(visiblePaneFromLayout(layout([group], "tabs"))).toBe("term:tabs");
	});

	it.each([undefined, {}, { grid: null }, layout([], "missing"), layout([leaf("hidden", false)], "hidden")])(
		"does not invent a target for an empty, hidden or missing layout: %j", (tree) => {
			expect(visiblePaneFromLayout(tree)).toBeUndefined();
	});
});
