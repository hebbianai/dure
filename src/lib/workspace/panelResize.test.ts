import { describe, expect, it } from "vitest";
import { clampPanelWidth, panelWidthCeiling } from "@/lib/workspace/panelResize";

const bounds = { min: 160, max: 600 };

describe("clampPanelWidth", () => {
	it("범위 안의 값은 정수로 그대로 통과한다", () => {
		expect(clampPanelWidth(300.4, bounds)).toBe(300);
	});

	it("양쪽 경계에서 클램프한다", () => {
		expect(clampPanelWidth(10, bounds)).toBe(160);
		expect(clampPanelWidth(9999, bounds)).toBe(600);
	});

	it("경계값 자체는 그대로다", () => {
		expect(clampPanelWidth(160, bounds)).toBe(160);
		expect(clampPanelWidth(600, bounds)).toBe(600);
	});

	// 창을 아주 좁게 만들면 max가 min보다 작아진다. 그때 목록이 사라지는 것보다
	// 넘치는 게 낫다.
	it("max가 min보다 작으면 min을 우선한다", () => {
		expect(clampPanelWidth(50, { min: 160, max: 80 })).toBe(160);
		expect(clampPanelWidth(400, { min: 160, max: 80 })).toBe(160);
	});

	it("숫자가 아닌 좌표는 min으로 떨어진다 — NaN 폭을 스타일에 넣지 않는다", () => {
		expect(clampPanelWidth(Number.NaN, bounds)).toBe(160);
		expect(clampPanelWidth(Number.POSITIVE_INFINITY, bounds)).toBe(160);
	});
});

describe("panelWidthCeiling", () => {
	it("창 폭의 절반을 넘지 않는다 — 목록이 본문보다 넓어지지 않게", () => {
		expect(panelWidthCeiling(1000)).toBe(500);
		expect(panelWidthCeiling(999)).toBe(499);
	});

	it("창 폭이 없으면 0이다 (측정 전)", () => {
		expect(panelWidthCeiling(0)).toBe(0);
		expect(panelWidthCeiling(-10)).toBe(0);
	});
});
