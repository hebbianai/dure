import injectSource from "@/generated/designModeInject.js?raw";
import { cropBrowserElementImage } from "@/lib/browser/browserElementImage";
import type { BrowserPaneSession } from "@/lib/browser/browserPaneSession";
import {
	type BrowserFrame,
	sameBrowserPage,
} from "@/lib/browser/browserResourceContract";
import { remoteCapturedElement } from "@/lib/design/designModeBrowser";
import type { CapturedElement } from "@/lib/design/designModeCapture";
import type { DroppedFilePayload } from "@/lib/files/externalFileDrop";
import { asRecord } from "@/lib/payloadGuards";

/** The existing Design Mode collector runs inside the admitted page evaluation.
 * The bundle stays function-scoped and its standalone hash bridge is not started. */
export function browserElementCaptureScript(point?: {
	x: number;
	y: number;
}): string {
	if (point && (!Number.isFinite(point.x) || !Number.isFinite(point.y))) {
		throw new Error("browser_capture_point_invalid");
	}
	return `(() => {${injectSource}\nreturn __DureDesignModeBundle.captureAtPoint(${point ? JSON.stringify(point) : ""});})()`;
}

export interface BrowserElementCapture {
	captured: CapturedElement;
	attachment?: DroppedFilePayload;
	attachmentError?: boolean;
}

/** Empty page space is an ordinary hover result, not a failed page action. */
export function browserElementPreviewScript(point: {
	x: number;
	y: number;
}): string {
	return `(() => { try { return ${browserElementCaptureScript(point)}; } catch (error) {
		if (error?.message === "browser_capture_target_missing" || error?.message === "browser_capture_target_excluded") return null;
		throw error;
	} })()`;
}

async function readBrowserElement(
	session: BrowserPaneSession,
	frame: BrowserFrame,
	script: string,
	current: () => boolean,
) {
	const data = await session.input({ kind: "evaluate", script }, frame.page);
	if (!current()) return undefined;
	const result = asRecord(data)?.result;
	if (result === null) return undefined;
	const captured = remoteCapturedElement({
		kind: "pick",
		body: { captured: result },
	});
	if (!captured) throw new Error("browser_capture_payload_invalid");
	return captured;
}

export function inspectBrowserElement(
	session: BrowserPaneSession,
	frame: BrowserFrame,
	point: { x: number; y: number },
	signal: AbortSignal,
): Promise<CapturedElement | undefined> {
	return withCurrentBrowserElement(session, frame, signal, (current) =>
		readBrowserElement(
			session,
			frame,
			browserElementPreviewScript(point),
			current,
		),
	);
}

/** A late result belongs to its original page and controller. Presentation
 * cancellation does not cancel or replay an already admitted runtime action. */
async function withCurrentBrowserElement<T>(
	session: BrowserPaneSession,
	frame: BrowserFrame,
	signal: AbortSignal,
	run: (current: () => boolean) => Promise<T>,
): Promise<T | undefined> {
	const lease = session.read().control?.controller;
	let current = !signal.aborted;
	const observe = () => {
		const view = session.read();
		current &&= Boolean(
			view.page &&
				sameBrowserPage(view.page, frame.page) &&
				lease &&
				view.control?.controller?.controller_id === lease.controller_id &&
				view.control.controller.epoch === lease.epoch,
		);
	};
	observe();
	if (!current) return;
	const stop = session.subscribe(observe);
	try {
		const result = await run(() => current && !signal.aborted);
		if (!current || signal.aborted) return;
		return result;
	} finally {
		stop();
	}
}

export function captureBrowserElement(
	session: BrowserPaneSession,
	frame: BrowserFrame,
	point: { x: number; y: number } | undefined,
	signal: AbortSignal,
	crop = cropBrowserElementImage,
): Promise<BrowserElementCapture | undefined> {
	return withCurrentBrowserElement(session, frame, signal, async (current) => {
		const captured = await readBrowserElement(
			session,
			frame,
			browserElementCaptureScript(point),
			current,
		);
		if (!current()) return;
		if (!captured) throw new Error("browser_capture_payload_invalid");
		let attachment: DroppedFilePayload | undefined;
		let attachmentError = false;
		try {
			attachment = await crop(
				await session.client.capture(frame.page, crypto.randomUUID(), signal),
				captured.rect,
			);
		} catch {
			attachmentError = true;
		}
		if (!current()) return;
		return {
			captured,
			...(attachment ? { attachment } : {}),
			...(attachmentError ? { attachmentError } : {}),
		};
	});
}
