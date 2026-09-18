import { expect, it } from "vitest";
import { mobileFramebufferGesture } from "./presentation";

it("maps landscape view input back to the physical iOS framebuffer and refuses portrait observations", () => {
	const frame = { dataUrl: "", width: 800, height: 400 };
	const gesture = {
		kind: "gesture",
		start: { x: 0.25, y: 0.75 },
		end: { x: 0.5, y: 0.2 },
		width: 800,
		height: 400,
	} as const;
	expect(mobileFramebufferGesture(gesture, frame, true)).toEqual({
		...gesture,
		start: { x: 0.25, y: 0.25 },
		end: { x: 0.8, y: 0.5 },
		width: 400,
		height: 800,
	});
	expect(
		mobileFramebufferGesture(
			{ ...gesture, width: 400, height: 800 },
			frame,
			true,
		),
	).toBeNull();
	expect(mobileFramebufferGesture(gesture, undefined, true)).toBeNull();
	expect(mobileFramebufferGesture(gesture, frame, false)).toBe(gesture);
});
