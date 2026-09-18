import { t } from "@/lib/i18n";
import type {
	MobileDeviceAction,
	MobileFrame,
} from "@/lib/ipc/mobileSimulator";

/** iOS exports its physical portrait framebuffer even after a landscape request.
 * This is the pane's chosen viewing angle, not an inferred device attitude. */
export async function presentMobileFrame(
	frame: MobileFrame,
	landscape: boolean,
): Promise<MobileFrame> {
	if (!landscape) return frame;
	const image = new Image();
	await new Promise<void>((resolve, reject) => {
		image.onload = () => resolve();
		image.onerror = () =>
			reject(new Error(t("panels.mobile.frameUnavailable")));
		image.src = frame.dataUrl;
	});
	const canvas = document.createElement("canvas");
	canvas.width = frame.height;
	canvas.height = frame.width;
	const context = canvas.getContext("2d");
	if (!context) throw new Error(t("panels.mobile.frameUnavailable"));
	context.translate(0, frame.width);
	context.rotate(-Math.PI / 2);
	context.drawImage(image, 0, 0, frame.width, frame.height);
	return {
		dataUrl: canvas.toDataURL(
			frame.dataUrl.startsWith("data:image/jpeg") ? "image/jpeg" : "image/png",
			0.9,
		),
		width: canvas.width,
		height: canvas.height,
	};
}

export function mobileFramebufferGesture(
	action: Extract<MobileDeviceAction, { kind: "gesture" }>,
	frame: MobileFrame | undefined,
	landscape: boolean,
): Extract<MobileDeviceAction, { kind: "gesture" }> | null {
	if (!frame || action.width !== frame.width || action.height !== frame.height)
		return null;
	if (!landscape) return action;
	const raw = (point: { x: number; y: number }) => ({
		x: 1 - point.y,
		y: point.x,
	});
	return {
		...action,
		start: raw(action.start),
		end: raw(action.end),
		width: action.height,
		height: action.width,
	};
}
