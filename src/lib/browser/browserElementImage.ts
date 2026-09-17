import type { BrowserFrame } from "@/lib/browser/browserResourceContract";
import type { CapturedElement } from "@/lib/design/designModeCapture";
import type { DroppedFilePayload } from "@/lib/files/externalFileDrop";
import { bytesToBase64 } from "@/lib/platform/base64";

/** Crop against the screenshot's actual decoded dimensions. Density and
 * browser zoom are already reflected in those pixels and the native viewport. */
export function browserElementImageRect(
	image: { width: number; height: number },
	viewport: BrowserFrame["viewport"],
	rect: CapturedElement["rect"],
) {
	if (
		![image.width, image.height, viewport.width, viewport.height].every(
			(v) => Number.isFinite(v) && v > 0,
		) ||
		![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ||
		rect.width <= 0 ||
		rect.height <= 0
	)
		throw new Error("browser_capture_dimensions_invalid");
	const left = Math.max(0, Math.floor((rect.x * image.width) / viewport.width));
	const top = Math.max(
		0,
		Math.floor((rect.y * image.height) / viewport.height),
	);
	const right = Math.min(
		image.width,
		Math.ceil(((rect.x + rect.width) * image.width) / viewport.width),
	);
	const bottom = Math.min(
		image.height,
		Math.ceil(((rect.y + rect.height) * image.height) / viewport.height),
	);
	if (right <= left || bottom <= top)
		throw new Error("browser_capture_element_not_visible");
	return { x: left, y: top, width: right - left, height: bottom - top };
}

export async function cropBrowserElementImage(
	frame: BrowserFrame,
	rect: CapturedElement["rect"],
): Promise<DroppedFilePayload> {
	const image = new Image();
	image.src = `data:${frame.mimeType};base64,${frame.base64}`;
	await image.decode();
	const crop = browserElementImageRect(
		{ width: image.naturalWidth, height: image.naturalHeight },
		frame.viewport,
		rect,
	);
	const canvas = document.createElement("canvas");
	canvas.width = crop.width;
	canvas.height = crop.height;
	const context = canvas.getContext("2d");
	if (!context) throw new Error("browser_capture_canvas_unavailable");
	context.drawImage(
		image,
		crop.x,
		crop.y,
		crop.width,
		crop.height,
		0,
		0,
		crop.width,
		crop.height,
	);
	const blob = await new Promise<Blob | null>((resolve) =>
		canvas.toBlob(resolve, "image/png"),
	);
	if (!blob) throw new Error("browser_capture_image_unavailable");
	return {
		fileName: "dure-browser-element.png",
		dataB64: bytesToBase64(new Uint8Array(await blob.arrayBuffer())),
	};
}
