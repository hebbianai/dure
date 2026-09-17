import { describe, expect, it } from "vitest";
import {
	MAX_ZOOM,
	MIN_ZOOM,
	clampZoom,
	fitScale,
	stepZoom,
	wheelZoom,
} from "@/lib/files/imageZoom";

describe("imageZoom", () => {
	it("클램프 — 범위 밖과 비정상 입력을 정리한다", () => {
		expect(clampZoom(0.01)).toBe(MIN_ZOOM);
		expect(clampZoom(100)).toBe(MAX_ZOOM);
		expect(clampZoom(Number.NaN)).toBe(1);
		expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(1);
	});

	it("스텝 줌은 왕복해도 원래 배율로 돌아온다", () => {
		const zoomedIn = stepZoom(1, 1);
		expect(zoomedIn).toBeCloseTo(1.25);
		expect(stepZoom(zoomedIn, -1)).toBeCloseTo(1);
	});

	it("휠 줌 — 위로(음수 deltaY) 확대, 아래로 축소, 클램프 준수", () => {
		expect(wheelZoom(1, -400)).toBeCloseTo(Math.E);
		expect(wheelZoom(1, 400)).toBeCloseTo(1 / Math.E);
		expect(wheelZoom(MAX_ZOOM, -4000)).toBe(MAX_ZOOM);
	});

	it("맞춤 배율 — 긴 축 기준, 원본보다 키우지 않는다", () => {
		expect(fitScale(2000, 1000, 1000, 1000)).toBe(0.5);
		expect(fitScale(100, 100, 1000, 1000)).toBe(1);
		expect(fitScale(0, 100, 1000, 1000)).toBe(1);
	});
});
