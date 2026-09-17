import { describe, expect, it } from "vitest";
import {
	DEFAULT_BOUNDARY_BAND_PX,
	interiorInsertionTarget,
	isFullSpanInsertion,
	isNoopSelfInsertion,
	type SerializedGrid,
	type SerializedGridNode,
} from "@/lib/workspace/pane/paneInsertion";

const leaf = (size: number): SerializedGridNode => ({
	type: "leaf",
	size,
	data: {},
});
const branch = (
	size: number,
	children: SerializedGridNode[],
): SerializedGridNode => ({
	type: "branch",
	size,
	data: children,
});

/** 컬럼 셋: 왼쪽 300 / 가운데 300 / 오른쪽 400, 높이 600. */
const threeColumns: SerializedGrid = {
	orientation: "HORIZONTAL",
	width: 1000,
	height: 600,
	root: branch(600, [leaf(300), leaf(300), leaf(400)]),
};

/** 왼쪽 컬럼이 위/아래로 나뉜 배치 — 사용자가 막힌 바로 그 형태.
 *  왼쪽 400(위 200 / 아래 400) | 오른쪽 600 */
const splitLeftColumn: SerializedGrid = {
	orientation: "HORIZONTAL",
	width: 1000,
	height: 600,
	root: branch(600, [branch(400, [leaf(200), leaf(400)]), leaf(600)]),
};

describe("interiorInsertionTarget", () => {
	it("두 컬럼 사이 경계에서 그 자리 삽입을 제안한다", () => {
		const target = interiorInsertionTarget(threeColumns, { x: 300, y: 300 });
		expect(target).not.toBeNull();
		expect(target?.location).toEqual([1]);
		expect(target?.orientation).toBe("HORIZONTAL");
	});

	it("두 번째 경계는 index 2다 — 그 자식 앞에 들어간다", () => {
		expect(
			interiorInsertionTarget(threeColumns, { x: 600, y: 100 })?.location,
		).toEqual([2]);
	});

	it("바깥 가장자리는 대상이 아니다 — dndEdges가 이미 처리한다", () => {
		expect(interiorInsertionTarget(threeColumns, { x: 0, y: 300 })).toBeNull();
		expect(
			interiorInsertionTarget(threeColumns, { x: 1000, y: 300 }),
		).toBeNull();
	});

	it("경계에서 멀면 제안하지 않는다 — 일반 split 추천을 잡아먹지 않는다", () => {
		expect(
			interiorInsertionTarget(threeColumns, { x: 150, y: 300 }),
		).toBeNull();
	});

	it("밴드 경계값은 포함이고 그 바로 밖은 제외다", () => {
		const inside = interiorInsertionTarget(threeColumns, {
			x: 300 + DEFAULT_BOUNDARY_BAND_PX,
			y: 300,
		});
		expect(inside?.location).toEqual([1]);
		expect(
			interiorInsertionTarget(threeColumns, {
				x: 300 + DEFAULT_BOUNDARY_BAND_PX + 1,
				y: 300,
			}),
		).toBeNull();
	});

	// 요청의 핵심: 왼쪽 컬럼이 두 그룹으로 나뉘어 있어도, 컬럼 사이 경계에서는
	// 그 중 한 그룹의 반쪽이 아니라 전체 높이 컬럼이 나와야 한다.
	it("왼쪽 컬럼이 상하로 쪼개져 있어도 컬럼 경계는 전체 높이 삽입이다", () => {
		const target = interiorInsertionTarget(splitLeftColumn, { x: 400, y: 500 });
		expect(target?.location).toEqual([1]);
		expect(target?.depth).toBe(0);
		expect(isFullSpanInsertion(target!)).toBe(true);
		expect(target?.rect.height).toBe(600);
	});

	it("컬럼 안쪽 가로 경계는 그 컬럼 폭만 차지하는 로우 삽입이다", () => {
		const target = interiorInsertionTarget(splitLeftColumn, { x: 100, y: 200 });
		expect(target?.location).toEqual([0, 1]);
		expect(target?.orientation).toBe("VERTICAL");
		expect(target?.depth).toBe(1);
		expect(isFullSpanInsertion(target!)).toBe(false);
		// 안쪽 로우는 그 컬럼(400px) 폭만 덮는다 — 전폭이 아니다.
		expect(target?.rect.width).toBe(400);
	});

	it("prefers the full-span boundary when intersecting boundaries are equally close", () => {
		// x=400 컬럼 경계와 y=200 로우 경계가 동시에 밴드 안인 모서리 지점.
		const target = interiorInsertionTarget(splitLeftColumn, { x: 400, y: 200 });
		expect(target?.depth).toBe(0);
		expect(target?.location).toEqual([1]);
	});

	it.each([
		{ x: 390, y: 199, location: [0, 1] },
		{ x: 390, y: 201, location: [0, 1] },
		{ x: 399, y: 190, location: [1] },
		{ x: 399, y: 210, location: [1] },
		{ x: 395, y: 195, location: [1] },
	])(
		"chooses the nearest intersecting boundary at ($x, $y)",
		({ x, y, location }) => {
			expect(
				interiorInsertionTarget(splitLeftColumn, { x, y })?.location,
			).toEqual(location);
		},
	);

	it("chooses the nearest same-depth boundary in narrow columns", () => {
		const narrow = {
			...threeColumns,
			root: branch(600, [leaf(400), leaf(20), leaf(580)]),
		};
		expect(
			interiorInsertionTarget(narrow, { x: 413, y: 300 })?.location,
		).toEqual([2]);
		expect(
			interiorInsertionTarget(narrow, { x: 407, y: 300 })?.location,
		).toEqual([1]);
	});

	it("branch 바깥(다른 컬럼 높이 구간)에서는 그 branch의 경계를 제안하지 않는다", () => {
		// 오른쪽 컬럼 한가운데 — 왼쪽 컬럼 내부 로우 경계와 x가 멀다.
		expect(
			interiorInsertionTarget(splitLeftColumn, { x: 800, y: 200 }),
		).toBeNull();
	});

	it("저장된 size 합이 실제 폭과 어긋나도 비율로 맞춘다", () => {
		// 합 900인데 실제 1000 — 경계는 300이 아니라 333에 있어야 한다.
		const drifted: SerializedGrid = {
			orientation: "HORIZONTAL",
			width: 1000,
			height: 600,
			root: branch(600, [leaf(300), leaf(300), leaf(300)]),
		};
		expect(
			interiorInsertionTarget(drifted, { x: 333, y: 300 })?.location,
		).toEqual([1]);
		expect(interiorInsertionTarget(drifted, { x: 300, y: 300 })).toBeNull();
	});

	it("size가 없으면 균등 분할로 본다", () => {
		const sizeless: SerializedGrid = {
			orientation: "HORIZONTAL",
			width: 1000,
			height: 600,
			root: {
				type: "branch",
				data: [
					{ type: "leaf", data: {} },
					{ type: "leaf", data: {} },
				],
			},
		};
		expect(
			interiorInsertionTarget(sizeless, { x: 500, y: 300 })?.location,
		).toEqual([1]);
	});

	it("숨긴 pane은 경계 좌표에서 제외하되 원래 grid index는 보존한다", () => {
		const hiddenMiddle: SerializedGrid = {
			orientation: "HORIZONTAL",
			width: 1000,
			height: 600,
			root: branch(600, [
				leaf(500),
				{ ...leaf(300), visible: false } as SerializedGridNode,
				leaf(500),
			]),
		};

		const target = interiorInsertionTarget(hiddenMiddle, { x: 500, y: 300 });
		expect(target?.location).toEqual([2]);
		expect(target?.rect.x).toBe(500 - DEFAULT_BOUNDARY_BAND_PX);
		expect(
			interiorInsertionTarget(hiddenMiddle, { x: 385, y: 300 }),
		).toBeNull();
	});

	it("leaf 하나뿐이면 안쪽 경계가 없다", () => {
		const single: SerializedGrid = {
			orientation: "HORIZONTAL",
			width: 1000,
			height: 600,
			root: branch(600, [leaf(1000)]),
		};
		expect(interiorInsertionTarget(single, { x: 500, y: 300 })).toBeNull();
	});

	it("크기 없는 컨테이너에서는 아무것도 제안하지 않는다", () => {
		expect(
			interiorInsertionTarget({ ...threeColumns, width: 0 }, { x: 0, y: 0 }),
		).toBeNull();
	});
});

describe("isNoopSelfInsertion", () => {
	const paneLeaf = (size: number, views: string[]): SerializedGridNode => ({
		type: "leaf",
		size,
		data: { id: `g-${views[0]}`, views },
	});
	/** [A, B, C] 컬럼 — 각 leaf에 pane 하나. */
	const grid: SerializedGrid = {
		orientation: "HORIZONTAL",
		width: 1000,
		height: 600,
		root: branch(600, [
			paneLeaf(300, ["a"]),
			paneLeaf(300, ["b"]),
			paneLeaf(400, ["c"]),
		]),
	};
	const targetAt = (x: number) => {
		const target = interiorInsertionTarget(grid, { x, y: 300 });
		if (!target) throw new Error("fixture: 경계 판정 실패");
		return target;
	};

	it("자기 양옆 경계는 무의미 — 삽입 후 원 그룹 제거로 순서가 그대로다", () => {
		// b(가운데)의 왼쪽 경계 index 1, 오른쪽 경계 index 2 — 둘 다 no-op.
		expect(isNoopSelfInsertion(grid, targetAt(300), "b")).toBe(true);
		expect(isNoopSelfInsertion(grid, targetAt(600), "b")).toBe(true);
	});

	it("떨어진 경계는 유효하다", () => {
		expect(isNoopSelfInsertion(grid, targetAt(600), "a")).toBe(false);
		expect(isNoopSelfInsertion(grid, targetAt(300), "c")).toBe(false);
	});

	it("중첩 branch 안의 pane은 인접해 보여도 유효하다 — 구조가 바뀐다", () => {
		// 왼쪽 컬럼이 위(a)/아래(b)로 나뉜 배치에서 a를 컬럼 경계로 끌면
		// 전체 높이 컬럼으로 빠져나오는 실제 이동이다.
		const nested: SerializedGrid = {
			orientation: "HORIZONTAL",
			width: 1000,
			height: 600,
			root: branch(600, [
				branch(400, [paneLeaf(200, ["a"]), paneLeaf(400, ["b"])]),
				paneLeaf(600, ["c"]),
			]),
		};
		const target = interiorInsertionTarget(nested, { x: 400, y: 300 });
		if (!target) throw new Error("fixture: 경계 판정 실패");
		expect(isNoopSelfInsertion(nested, target, "a")).toBe(false);
	});

	it("그룹에 pane이 더 남으면 인접 경계도 유효하다 — 혼자 빠져나오는 이동", () => {
		const multiView: SerializedGrid = {
			orientation: "HORIZONTAL",
			width: 1000,
			height: 600,
			root: branch(600, [
				paneLeaf(500, ["a"]),
				{ type: "leaf", size: 500, data: { id: "g-m", views: ["m", "n"] } },
			]),
		};
		const target = interiorInsertionTarget(multiView, { x: 500, y: 300 });
		if (!target) throw new Error("fixture: 경계 판정 실패");
		expect(isNoopSelfInsertion(multiView, target, "m")).toBe(false);
	});

	it("숨긴 sibling을 사이에 둔 보이는 이웃 경계도 자기 자리 이동이다", () => {
		const hiddenSibling = {
			...paneLeaf(300, ["hidden"]),
			visible: false,
		} as SerializedGridNode;
		const withHidden: SerializedGrid = {
			orientation: "HORIZONTAL",
			width: 1000,
			height: 600,
			root: branch(600, [
				paneLeaf(500, ["a"]),
				hiddenSibling,
				paneLeaf(500, ["c"]),
			]),
		};
		const target = interiorInsertionTarget(withHidden, { x: 500, y: 300 });
		if (!target) throw new Error("fixture: visible boundary was not detected");

		expect(isNoopSelfInsertion(withHidden, target, "a")).toBe(true);
	});
});
