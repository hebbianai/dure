// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
	type BrowserElementCapture,
	captureBrowserElement,
	inspectBrowserElement,
} from "@/lib/browser/browserElementCapture";
import type { BrowserPaneSession } from "@/lib/browser/browserPaneSession";
import type { BrowserFrame } from "@/lib/browser/browserResourceContract";
import type { CapturedElement } from "@/lib/design/designModeCapture";
import { BrowserElementPicker } from "./BrowserElementPicker";

vi.mock("@/lib/browser/browserElementCapture", () => ({
	captureBrowserElement: vi.fn(),
	inspectBrowserElement: vi.fn(),
}));
vi.mock("@/lib/i18n", () => ({ t: (key: string) => key }));
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.mocked(captureBrowserElement).mockReset();
	vi.mocked(inspectBrowserElement).mockReset();
});
const frame: BrowserFrame = {
	page: {
		resource: {
			resource_id: "browser:one",
			workspace_id: "workspace:one",
			generation: "generation:one",
		},
		page_id: "page:one",
		document_revision: "1",
	},
	viewport: { width: 800, height: 600, pixel_ratio: 2 },
	mimeType: "image/jpeg",
	base64: "aW1hZ2U=",
};
const session = {} as BrowserPaneSession;
const captured: BrowserElementCapture = {
	captured: { label: "button#save" } as CapturedElement,
	attachment: { fileName: "element.png", dataB64: "cG5n" },
};
function fixture() {
	let resolve!: (value: BrowserElementCapture) => void;
	const response = new Promise<BrowserElementCapture>((done) => {
		resolve = done;
	});
	vi.mocked(captureBrowserElement).mockImplementationOnce(() => response);

	const onCapture = vi.fn(),
		onClose = vi.fn();
	const mounted = render(
		<BrowserElementPicker
			session={session}
			frame={frame}
			onCapture={onCapture}
			onClose={onClose}
		/>,
	);
	const surface = screen.getByRole("button", {
		name: "panels.browser.pickElement",
	});
	vi.spyOn(surface, "getBoundingClientRect").mockReturnValue({
		x: 10,
		y: 20,
		left: 10,
		top: 20,
		right: 410,
		bottom: 420,
		width: 400,
		height: 400,
		toJSON() {},
	});
	return { ...mounted, surface, onCapture, onClose, resolve };
}
it("maps the visible image point, ignores letterboxing and waits for one capture", async () => {
	const f = fixture();
	fireEvent.click(f.surface, { detail: 1, clientX: 100, clientY: 400 });
	expect(captureBrowserElement).not.toHaveBeenCalled();
	fireEvent.click(f.surface, { detail: 1, clientX: 110, clientY: 120 });
	fireEvent.click(f.surface, { detail: 1, clientX: 110, clientY: 120 });
	expect(captureBrowserElement).toHaveBeenCalledTimes(1);
	expect(captureBrowserElement).toHaveBeenCalledWith(
		session,
		frame,
		{ x: 200, y: 200 },
		expect.any(AbortSignal),
	);
	f.resolve(captured);
	await waitFor(() => expect(f.onCapture).toHaveBeenCalledWith(captured));
});
it("keyboard activation captures page focus and Escape suppresses a late reply", async () => {
	const f = fixture();
	expect(document.activeElement).toBe(f.surface);
	fireEvent.click(f.surface, { detail: 0 });
	const signal = vi.mocked(captureBrowserElement).mock.calls[0][3];
	expect(vi.mocked(captureBrowserElement).mock.calls[0][2]).toBeUndefined();
	fireEvent.keyDown(f.surface, { key: "Escape" });
	expect(signal.aborted).toBe(true);
	expect(f.onClose).toHaveBeenCalledTimes(1);
	f.resolve(captured);
	await Promise.resolve();
	expect(f.onCapture).not.toHaveBeenCalled();
});
it("unmount cancels presentation of an in-flight capture", async () => {
	const f = fixture();
	fireEvent.click(f.surface, { detail: 0 });
	const signal = vi.mocked(captureBrowserElement).mock.calls[0][3];
	f.unmount();
	f.resolve(captured);
	await Promise.resolve();
	expect(signal.aborted).toBe(true);
	expect(f.onCapture).not.toHaveBeenCalled();
});
it("retains a failed capture for an explicit retry", async () => {
	const f = fixture();
	f.resolve(captured);
	vi.mocked(captureBrowserElement)
		.mockReset()
		.mockRejectedValueOnce(new Error("renderer gone"))
		.mockResolvedValueOnce(captured);
	fireEvent.click(f.surface, { detail: 0 });
	await screen.findByText("ipc.browser.requestFailed");
	expect(f.onCapture).not.toHaveBeenCalled();
	expect(captureBrowserElement).toHaveBeenCalledTimes(1);
	fireEvent.click(f.surface, { detail: 0 });
	await waitFor(() => expect(f.onCapture).toHaveBeenCalledTimes(1));
	expect(captureBrowserElement).toHaveBeenCalledTimes(2);
});

function move(surface: HTMLElement, clientX: number, clientY: number) {
	fireEvent(
		surface,
		new MouseEvent("pointermove", { bubbles: true, clientX, clientY }),
	);
}

it("previews the element under the pointer without capturing an image or clicking the page", async () => {
	const f = fixture();
	const element = {
		label: "button#save",
		rect: { x: 180, y: 190, width: 100, height: 40 },
	} as CapturedElement;
	vi.mocked(inspectBrowserElement).mockResolvedValue(element);
	move(f.surface, 110, 120);
	await waitFor(() =>
		expect(inspectBrowserElement).toHaveBeenCalledWith(
			session,
			frame,
			{ x: 200, y: 200 },
			expect.any(AbortSignal),
		),
	);
	await screen.findByText("button#save");
	const outline = f.container.querySelector("svg rect")!;
	expect(outline.getAttribute("x")).toBe("180");
	expect(outline.getAttribute("y")).toBe("190");
	expect(outline.getAttribute("width")).toBe("100");
	expect(outline.closest("svg")?.getAttribute("viewBox")).toBe("0 0 800 600");
	expect(captureBrowserElement).not.toHaveBeenCalled();
	expect(f.onCapture).not.toHaveBeenCalled();
	fireEvent.pointerLeave(f.surface);
	expect(screen.queryByText("button#save")).toBeNull();
	expect(f.container.querySelector("svg rect")).toBeNull();
});

it("keeps only the latest pointer while inspection is pending and suppresses stale replies", async () => {
	const f = fixture();
	let first!: (value: CapturedElement) => void;
	let last!: (value: CapturedElement) => void;
	vi.mocked(inspectBrowserElement)
		.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					first = resolve;
				}),
		)
		.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					last = resolve;
				}),
		);
	move(f.surface, 110, 120);
	move(f.surface, 120, 130);
	move(f.surface, 130, 140);
	expect(inspectBrowserElement).toHaveBeenCalledTimes(1);
	first({
		label: "obsolete",
		rect: { x: 10, y: 20, width: 20, height: 30 },
	} as CapturedElement);
	await waitFor(() => expect(inspectBrowserElement).toHaveBeenCalledTimes(2));
	expect(vi.mocked(inspectBrowserElement).mock.calls[1][2]).toEqual({
		x: 240,
		y: 240,
	});
	expect(screen.queryByText("obsolete")).toBeNull();
	move(f.surface, 110, 400);
	last({
		label: "left-page",
		rect: { x: 10, y: 20, width: 20, height: 30 },
	} as CapturedElement);
	await Promise.resolve();
	expect(screen.queryByText("left-page")).toBeNull();
	expect(inspectBrowserElement).toHaveBeenCalledTimes(2);
	expect(captureBrowserElement).not.toHaveBeenCalled();
});

it("aborts an unmounted preview and does not retry a failed observation automatically", async () => {
	const f = fixture();
	vi.mocked(inspectBrowserElement).mockRejectedValueOnce(
		new Error("renderer gone"),
	);
	move(f.surface, 110, 120);
	await screen.findByText("ipc.browser.requestFailed");
	expect(inspectBrowserElement).toHaveBeenCalledTimes(1);
	let finish!: (value: CapturedElement) => void;
	vi.mocked(inspectBrowserElement).mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	move(f.surface, 120, 130);
	const signal = vi.mocked(inspectBrowserElement).mock.calls[1][3];
	f.unmount();
	expect(signal.aborted).toBe(true);
	finish({ label: "unmounted" } as CapturedElement);
	await Promise.resolve();
	expect(f.onCapture).not.toHaveBeenCalled();
	expect(inspectBrowserElement).toHaveBeenCalledTimes(2);
});
