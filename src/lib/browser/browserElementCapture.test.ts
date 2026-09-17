// @vitest-environment jsdom
import injectSource from "@/generated/designModeInject.js?raw";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	browserElementCaptureScript,
	browserElementPreviewScript,
	inspectBrowserElement,
	captureBrowserElement,
} from "./browserElementCapture";
import type { BrowserPaneSession } from "./browserPaneSession";
import type { BrowserFrame } from "./browserResourceContract";
import { captureElement } from "@/lib/design/designModeCapture";
import { remoteCapturedElement } from "@/lib/design/designModeBrowser";
import { formatCapturedElement } from "@/lib/design/designModePrompt";

beforeEach(() => {
	Object.defineProperty(document, "elementFromPoint", {
		configurable: true,
		value: vi.fn(),
	});
});
afterEach(() => {
	document.body.innerHTML = "";
	vi.restoreAllMocks();
});

it("uses the shared collector on the visible element without clicking or installing a page bridge", () => {
	document.body.innerHTML =
		'<main><button id="save" data-dure-src="src/Page.tsx:12">저장</button></main>';
	const button = document.querySelector("button")!;
	const click = vi.fn();
	button.addEventListener("click", click);
	vi.spyOn(document, "elementFromPoint").mockReturnValue(button);
	const before = location.href;
	const captured = new Function(
		`return ${browserElementCaptureScript({ x: 12, y: 14 })}`,
	)();
	const expected = captureElement(button, { now: captured.page.capturedAt });
	expect(captured).toEqual(expected);
	expect(remoteCapturedElement({ kind: "pick", body: { captured } })).toEqual(
		captured,
	);
	expect(formatCapturedElement(captured)).toContain("src/Page.tsx:12");
	expect(captured.accessibility.accessibleName).toBe("저장");
	expect(document.elementFromPoint).toHaveBeenCalledWith(12, 14);
	expect(click).not.toHaveBeenCalled();
	expect(location.href).toBe(before);
	expect(
		(window as unknown as Record<string, unknown>).__DURE_DESIGN_MODE__,
	).toBeUndefined();
});

it("captures a keyboard-focused element and rejects empty page focus", () => {
	document.body.innerHTML = '<input aria-label="한글 입력">';
	const input = document.querySelector("input")!;
	input.focus();
	input.value = "보존";
	const captured = new Function(`return ${browserElementCaptureScript()}`)();
	expect(captured.accessibility.accessibleName).toBe("한글 입력");
	expect(input.value).toBe("보존");
	input.blur();
	expect(() =>
		new Function(`return ${browserElementCaptureScript()}`)(),
	).toThrow("browser_capture_target_missing");
});

it("captures SVG as one element and rejects content outside the page", () => {
	document.body.innerHTML =
		'<button><svg id="icon"><path d="M0 0"/></svg></button>';
	vi.spyOn(document, "elementFromPoint").mockReturnValue(
		document.querySelector("path"),
	);
	const run = () =>
		new Function(`return ${browserElementCaptureScript({ x: 2, y: 3 })}`)();
	expect(run().label).toBe("svg#icon");
	vi.mocked(document.elementFromPoint).mockReturnValue(null);
	expect(run).toThrow("browser_capture_target_missing");
	expect(() => browserElementCaptureScript({ x: NaN, y: 1 })).toThrow(
		"browser_capture_point_invalid",
	);
});

it("keeps the standalone window picker on its explicit install path", () => {
	vi.useFakeTimers();
	const globals = window as unknown as Record<string, unknown>;
	const before = location.href;
	try {
		globals.__DURE_DESIGN_MODE_CONFIG__ = { nonce: "fixture-nonce" };
		new Function(`${injectSource}; __DureDesignModeBundle.install();`)();
		const api = globals.__DURE_DESIGN_MODE__ as {
			probe(): { ipc: boolean };
			start(): boolean;
			stop(): void;
			active(): boolean;
		};
		expect(api.probe().ipc).toBe(true);
		expect(api.start()).toBe(true);
		expect(api.active()).toBe(true);
		api.stop();
		expect(api.active()).toBe(false);
	} finally {
		delete globals.__DURE_DESIGN_MODE_CONFIG__;
		delete globals.__DURE_DESIGN_MODE__;
		history.replaceState(null, "", before);
		vi.clearAllTimers();
		vi.useRealTimers();
	}
});

it("treats empty and excluded hover targets as empty observations while explicit capture still reports them", () => {
	const preview = () =>
		new Function(`return ${browserElementPreviewScript({ x: 1, y: 2 })}`)();
	vi.mocked(document.elementFromPoint).mockReturnValue(document.body);
	expect(preview()).toBeNull();
	document.body.innerHTML =
		'<div class="cm-content"><span>editor text</span></div>';
	vi.mocked(document.elementFromPoint).mockReturnValue(
		document.querySelector("span"),
	);
	expect(preview()).toBeNull();
	expect(() =>
		new Function(`return ${browserElementCaptureScript({ x: 1, y: 2 })}`)(),
	).toThrow("browser_capture_target_excluded");
	vi.mocked(document.elementFromPoint).mockImplementation(() => {
		throw new Error("unexpected page failure");
	});
	expect(preview).toThrow("unexpected page failure");
});

function observedSession() {
	const page = {
		resource: {
			resource_id: "browser:preview",
			workspace_id: "workspace:preview",
			generation: "generation:preview",
		},
		page_id: "page:1",
		document_revision: "1",
	};
	const frame = {
		page,
		viewport: { width: 800, height: 600, pixel_ratio: 1 },
		mimeType: "image/jpeg",
		base64: "",
	} as BrowserFrame;
	const view = {
		page,
		control: { controller: { controller_id: "view:one", epoch: "1" } },
	};
	const listeners = new Set<() => void>();
	const client = { capture: vi.fn() };
	const input = vi.fn(async (action: { script: string }) => ({
		result: new Function(`return ${action.script}`)(),
	}));
	const session = {
		read: () => view,
		subscribe: (callback: () => void) => {
			listeners.add(callback);
			return () => {
				listeners.delete(callback);
			};
		},
		input,
		client,
	} as unknown as BrowserPaneSession;
	return { session, frame, view, listeners, client, input };
}

it("inspects through the real collector and shares capture authority without requesting an image", async () => {
	const f = observedSession();
	document.body.innerHTML = '<button id="save">저장</button>';
	const button = document.querySelector("button")!;
	vi.mocked(document.elementFromPoint).mockReturnValue(button);
	const click = vi.fn();
	button.addEventListener("click", click);
	const inspected = await inspectBrowserElement(
		f.session,
		f.frame,
		{ x: 20, y: 30 },
		new AbortController().signal,
	);
	expect(inspected?.label).toBe("button#save");
	expect(inspected?.accessibility.accessibleName).toBe("저장");
	expect(f.input.mock.calls[0][0]).toMatchObject({ kind: "evaluate" });
	expect(f.client.capture).not.toHaveBeenCalled();
	expect(click).not.toHaveBeenCalled();
	expect(f.listeners.size).toBe(0);
	f.client.capture.mockResolvedValue(f.frame);
	const attachment = { fileName: "element.png", dataB64: "cG5n" };
	const crop = vi.fn(async () => attachment);
	const captured = await captureBrowserElement(
		f.session,
		f.frame,
		{ x: 20, y: 30 },
		new AbortController().signal,
		crop,
	);
	expect(captured?.captured.label).toBe(inspected?.label);
	expect(captured?.attachment).toEqual(attachment);
	expect(crop).toHaveBeenCalledWith(f.frame, inspected?.rect);
	expect(f.client.capture).toHaveBeenCalledTimes(1);
	expect(f.listeners.size).toBe(0);
});

for (const change of ["controller", "document", "abort"] as const)
	it(`discards a late inspection after ${change} changes`, async () => {
		const f = observedSession();
		const active = new AbortController();
		let finish!: (value: { result: unknown }) => void;
		f.input.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		document.body.innerHTML = '<button id="old">Old target</button>';
		const captured = captureElement(document.querySelector("button")!);
		const reading = inspectBrowserElement(
			f.session,
			f.frame,
			{ x: 1, y: 1 },
			active.signal,
		);
		if (change === "controller")
			f.view.control.controller = { controller_id: "view:two", epoch: "2" };
		if (change === "document")
			f.view.page = { ...f.frame.page, document_revision: "2" };
		if (change === "abort") active.abort();
		for (const observe of f.listeners) observe();
		finish({ result: captured });
		expect(await reading).toBeUndefined();
		expect(f.client.capture).not.toHaveBeenCalled();
		expect(f.listeners.size).toBe(0);
	});

for (const read of [inspectBrowserElement, captureBrowserElement])
	it("discards an obsolete malformed payload before validating another controller's result", async () => {
		const f = observedSession();
		let finish!: (value: { result: unknown }) => void;
		f.input.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const reading = read(
			f.session,
			f.frame,
			{ x: 1, y: 1 },
			new AbortController().signal,
		);
		f.view.control.controller = { controller_id: "view:two", epoch: "2" };
		for (const observe of f.listeners) observe();
		finish({ result: "malformed obsolete payload" });
		expect(await reading).toBeUndefined();
		expect(f.client.capture).not.toHaveBeenCalled();
		expect(f.listeners.size).toBe(0);
	});
