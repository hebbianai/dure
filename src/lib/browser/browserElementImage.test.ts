import { expect, it } from "vitest";
import { browserElementImageRect } from "./browserElementImage";

const viewport = { width: 400, height: 300, pixel_ratio: 2 };
it("maps a CSS element to the actual screenshot pixels", () => {
	expect(
		browserElementImageRect({ width: 800, height: 600 }, viewport, {
			x: 10.25,
			y: 20.5,
			width: 30.5,
			height: 40,
		}),
	).toEqual({ x: 20, y: 41, width: 62, height: 80 });
});
it("clips partially visible elements without including pixels outside the viewport", () => {
	expect(
		browserElementImageRect({ width: 800, height: 600 }, viewport, {
			x: -10,
			y: 280,
			width: 100,
			height: 60,
		}),
	).toEqual({ x: 0, y: 560, width: 180, height: 40 });
});
it("uses decoded dimensions instead of guessing from device pixel ratio", () => {
	expect(
		browserElementImageRect({ width: 400, height: 300 }, viewport, {
			x: 10,
			y: 20,
			width: 30,
			height: 40,
		}),
	).toEqual({ x: 10, y: 20, width: 30, height: 40 });
});
for (const rect of [
	{ x: 500, y: 1, width: 20, height: 30 },
	{ x: 1, y: 1, width: 0, height: 30 },
	{ x: NaN, y: 1, width: 20, height: 30 },
])
	it("rejects an invisible or invalid crop", () => {
		expect(() =>
			browserElementImageRect({ width: 800, height: 600 }, viewport, rect),
		).toThrow();
	});
