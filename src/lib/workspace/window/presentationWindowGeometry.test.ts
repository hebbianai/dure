import { describe, expect, it } from "vitest";
import { presentationWindowGeometry } from "@/lib/workspace/window/presentationWindowGeometry";

describe("presentationWindowGeometry", () => {
	it("covers most of a Retina work area, centred in logical pixels", () => {
		expect(
			presentationWindowGeometry({
				scaleFactor: 2,
				workArea: {
					position: { x: 0, y: 50 },
					size: { width: 3024, height: 1814 },
				},
			}),
		).toEqual({ width: 1361, height: 816, x: 76, y: 71 });
	});

	it("centres on a secondary display offset from the primary one", () => {
		expect(
			presentationWindowGeometry({
				scaleFactor: 1,
				workArea: {
					position: { x: -1920, y: 0 },
					size: { width: 1920, height: 1040 },
				},
			}),
		).toEqual({ width: 1728, height: 936, x: -1824, y: 52 });
	});

	it("never shrinks below the minimum on a small display unless the display is smaller", () => {
		expect(
			presentationWindowGeometry({
				scaleFactor: 1,
				workArea: { position: { x: 0, y: 0 }, size: { width: 500, height: 380 } },
			}),
		).toEqual({ width: 480, height: 360, x: 10, y: 10 });
		expect(
			presentationWindowGeometry({
				scaleFactor: 1,
				workArea: { position: { x: 0, y: 0 }, size: { width: 400, height: 300 } },
			}),
		).toEqual({ width: 400, height: 300, x: 0, y: 0 });
	});

	it.each([
		null,
		undefined,
		{ scaleFactor: 0, workArea: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 } } },
		{ scaleFactor: Number.NaN, workArea: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 } } },
		{ scaleFactor: 1, workArea: { position: { x: 0, y: 0 }, size: { width: 0, height: 1080 } } },
	])("falls back to a large OS-centred window without a usable display: %j", (monitor) => {
		expect(presentationWindowGeometry(monitor)).toEqual({
			width: 1280,
			height: 860,
			center: true,
		});
	});
});
