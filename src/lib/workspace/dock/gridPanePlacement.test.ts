import type { DockviewApi } from "dockview-react";
import { describe, expect, it } from "vitest";
import {
	pickAutoSplit,
	pickGridSplit,
	rightRailPosition,
} from "@/lib/workspace/dock/gridPanePlacement";

describe("rightRailPosition measurement boundary", () => {
	const panel = (id: string, width: number, component = "agent") => ({
		id,
		api: { component },
		group: { id, api: { width, isVisible: true, location: { type: "grid" } } },
	});

	it("leaves the first pane unpositioned", () => {
		expect(
			rightRailPosition({ width: 1200, panels: [] } as unknown as DockviewApi),
		).toBeUndefined();
	});

	it.each([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
		"does not request an absolute width before the workspace is measured: %s",
		(width) => {
			expect(
				rightRailPosition({
					width,
					panels: [panel("agent:first", 1200)],
				} as unknown as DockviewApi),
			).toEqual({ direction: "right" });
		},
	);

	it("uses terminal widths when no visible agent width is usable", () => {
		expect(
			rightRailPosition({
				width: 1200,
				panels: [
					panel("term:first", 1200, "terminal"),
					panel("agent:unmeasured", 0),
					panel("agent:invalid", Number.NaN),
				],
			} as unknown as DockviewApi),
		).toEqual({ direction: "right", initialWidth: 600 });
	});

	it("leaves default sizing to Dockview when neither agent nor terminal width is usable", () => {
		expect(
			rightRailPosition({
				width: 1200,
				panels: [
					panel("file:first", 1200, "file"),
					panel("term:unmeasured", 0, "terminal"),
					panel("agent:invalid", Number.NaN),
				],
			} as unknown as DockviewApi),
		).toEqual({ direction: "right" });
	});

	it("counts each visible grid terminal group once in the fallback", () => {
		const first = panel("term:first", 400, "terminal");
		const hidden = panel("term:hidden", 1200, "terminal");
		hidden.group.api.isVisible = false;
		const floating = panel("term:floating", 1200, "terminal");
		floating.group.api.location.type = "floating";
		expect(
			rightRailPosition({
				width: 1200,
				panels: [
					first,
					{ ...first, id: "term:tab" },
					panel("term:second", 800, "terminal"),
					hidden,
					floating,
					panel("file:first", 1200, "file"),
				],
			} as unknown as DockviewApi),
		).toEqual({ direction: "right", initialWidth: 400 });
	});

	it.each(["slot", "launcher:previous", "term:previous", "agent:current"])(
		"measures actual Agent content at %s, ignoring historical Agent spellings",
		(panelId) => {
			expect(
				rightRailPosition({
					width: 1200,
					panels: [panel(panelId, 600), panel("agent:old", 1200, "terminal")],
				} as unknown as DockviewApi),
			).toEqual({ direction: "right", initialWidth: 400 });
		},
	);
});

describe("pickGridSplit", () => {
	it("가로로 넓은 단일 그룹은 오른쪽으로 쪼갠다 (2번째 pane → 좌우)", () => {
		expect(pickGridSplit([{ id: "a", width: 1600, height: 900 }])).toEqual({
			referenceGroupId: "a",
			direction: "right",
		});
	});

	it("세로가 긴 그룹은 아래로 쪼갠다 (3번째 pane부터 격자가 된다)", () => {
		// 1600×900을 좌우로 나눈 뒤: 각 800×900 — 세로가 길어 below.
		expect(
			pickGridSplit([
				{ id: "left", width: 800, height: 900 },
				{ id: "right", width: 790, height: 900 },
			]),
		).toEqual({ referenceGroupId: "left", direction: "below" });
	});

	it("가장 큰 그룹을 고른다 — 이미 쪼개진 작은 칸이 아니라", () => {
		// 2×1 + 아래 반칸 상태: 오른쪽 온전한 기둥이 가장 크다.
		expect(
			pickGridSplit([
				{ id: "top-left", width: 800, height: 450 },
				{ id: "bottom-left", width: 800, height: 450 },
				{ id: "right", width: 800, height: 900 },
			]),
		).toEqual({ referenceGroupId: "right", direction: "below" });
	});

	it("정사각형은 가로 분할 — 내용이 가로로 긴 매체다", () => {
		expect(
			pickGridSplit([{ id: "a", width: 900, height: 900 }])?.direction,
		).toBe("right");
	});

	it("크기를 모르는(0) 그룹뿐이면 undefined — 호출부 폴백", () => {
		expect(pickGridSplit([{ id: "a", width: 0, height: 0 }])).toBeUndefined();
		expect(pickGridSplit([])).toBeUndefined();
	});

	it("연속 추가 시뮬레이션: 1→4개가 2×2로 수렴한다", () => {
		// 각 분할이 균등하다고 가정하고 판정만 따라간다.
		const first = pickGridSplit([{ id: "g1", width: 1600, height: 900 }]);
		expect(first?.direction).toBe("right"); // 2개: 좌|우
		const second = pickGridSplit([
			{ id: "g1", width: 800, height: 900 },
			{ id: "g2", width: 800, height: 900 },
		]);
		expect(second?.direction).toBe("below"); // 3개: 한 기둥이 위/아래
		const third = pickGridSplit([
			{ id: "g1", width: 800, height: 450 },
			{ id: "g3", width: 800, height: 450 },
			{ id: "g2", width: 800, height: 900 },
		]);
		// 4개째: 남은 온전한 기둥을 아래로 → 2×2 완성
		expect(third).toEqual({ referenceGroupId: "g2", direction: "below" });
	});
});

describe("pickAutoSplit", () => {
	const grid = [
		{ id: "small", width: 800, height: 450 },
		{ id: "big", width: 800, height: 900 },
	];

	it("활성 그룹을 그 그룹의 긴 축으로 쪼갠다 — 가장 큰 그룹이 아니라", () => {
		expect(pickAutoSplit(grid, "small")).toEqual({
			referenceGroupId: "small",
			direction: "right",
		});
		expect(pickAutoSplit(grid, "big")).toEqual({
			referenceGroupId: "big",
			direction: "below",
		});
	});

	it("긴 축 반쪽이 하한 미달이면 다른 축을 시도한다", () => {
		// 630×500: right는 315(<320) 탈락, below는 250(≥220) 통과.
		expect(
			pickAutoSplit([{ id: "a", width: 630, height: 500 }], "a"),
		).toEqual({ referenceGroupId: "a", direction: "below" });
	});

	it("두 축 모두 하한 미달이면 가장 큰 그룹 규칙으로 폴백한다", () => {
		expect(
			pickAutoSplit(
				[{ id: "tiny", width: 600, height: 400 }, ...grid],
				"tiny",
			),
		).toEqual({ referenceGroupId: "big", direction: "below" });
	});

	it("활성 그룹을 모르면(floating 활성 등) 가장 큰 그룹 규칙", () => {
		expect(pickAutoSplit(grid, undefined)).toEqual({
			referenceGroupId: "big",
			direction: "below",
		});
	});

	it("연속 추가 시뮬레이션: 활성(직전 추가) 기준 스파이럴이 격자로 수렴", () => {
		// 1600×900 하나에서 시작, 새 pane이 활성이 된다고 가정.
		const first = pickAutoSplit([{ id: "g1", width: 1600, height: 900 }], "g1");
		expect(first?.direction).toBe("right"); // 좌|우
		const second = pickAutoSplit(
			[
				{ id: "g1", width: 800, height: 900 },
				{ id: "g2", width: 800, height: 900 },
			],
			"g2",
		);
		expect(second).toEqual({ referenceGroupId: "g2", direction: "below" }); // 우측 기둥 위/아래
		const third = pickAutoSplit(
			[
				{ id: "g1", width: 800, height: 900 },
				{ id: "g2", width: 800, height: 450 },
				{ id: "g3", width: 800, height: 450 },
			],
			"g3",
		);
		expect(third).toEqual({ referenceGroupId: "g3", direction: "right" }); // 우하단 좌|우
	});
});
