import { expect, it } from "vitest";
import { browserFramePoint } from "./browserFramePoint";
import type { BrowserFrame } from "./browserResourceContract";

it("maps Retina frames to CSS coordinates and ignores letterboxing, while retaining captured drags", () => {
	const frame: BrowserFrame = {
		page: {
			resource: {
				resource_id: "browser:one",
				generation: "one",
				workspace_id: "workspace:one",
			},
			page_id: "page:one",
			document_revision: "1",
		},
		mimeType: "image/jpeg",
		base64: "image",
		viewport: { width: 400, height: 600, pixel_ratio: 2 },
	};
	const bounds = { left: 30, top: 50, width: 400, height: 300 };
	expect(browserFramePoint(frame, bounds, 130, 130)).toEqual({
		x: 200,
		y: 160,
	});
	expect(browserFramePoint(frame, bounds, 330, 130)).toBeUndefined();
	expect(browserFramePoint(frame, bounds, 330, 130, true)).toEqual({
		x: 600,
		y: 160,
	});
	expect(
		browserFramePoint(frame, { ...bounds, width: 0 }, 130, 130),
	).toBeUndefined();
});
