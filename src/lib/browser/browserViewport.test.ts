import { expect, it } from "vitest";
import { browserViewport } from "./browserViewport";

it("keeps CSS layout size while reducing the physical capture on a large Retina display", () => {
	const size = browserViewport(3840, 2160, 2);
	expect(size).toMatchObject({ width: 3840, height: 2160 });
	expect(size?.scale).toBeGreaterThan(1);
	expect(3840 * 2160 * (size?.scale ?? 0) ** 2).toBeLessThanOrEqual(16_000_000);
	expect(browserViewport(480, 610, 2)).toEqual({
		width: 480,
		height: 610,
		scale: 2,
	});
	expect(browserViewport(0, 0, 2)).toBeUndefined();
});

it("keeps the rounded physical frame within capture limits", () => {
	for (const [width, height] of [
		[2404, 1800],
		[2405, 2160],
		[65535, 1],
		[1, 65535],
	]) {
		const size = browserViewport(width, height, 2);
		expect(size).toBeDefined();
		const pixels = [
			Math.ceil(width * (size?.scale ?? 0)),
			Math.ceil(height * (size?.scale ?? 0)),
		];
		expect(pixels[0] * pixels[1]).toBeLessThanOrEqual(16_000_000);
		expect(Math.max(...pixels)).toBeLessThanOrEqual(65_535);
	}
});
