// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	capture: vi.fn(),
}));

vi.mock("@/lib/ipc/feedback", () => ({
	feedbackCaptureMainWindow: mocks.capture,
}));

vi.mock("@/components/feedback/FeedbackDialog", () => ({
	FeedbackDialog: ({
		capture,
		onOpenChange,
	}: {
		capture: { ok: boolean };
		onOpenChange: (open: boolean) => void;
	}) => (
		<>
			<div data-testid="feedback-dialog-loaded">{String(capture.ok)}</div>
			{/* Outside the testid element so the existing textContent
			    assertions still read only the capture outcome. */}
			<button type="button" onClick={() => onOpenChange(false)}>
				close
			</button>
		</>
	),
}));

import { LazyFeedbackDialog } from "@/components/feedback/LazyFeedbackDialog";
import { requestFeedback } from "@/lib/feedback/feedbackActivation";

const png = { pngB64: "abc", width: 10, height: 10 };

// The real chord: on a US layout, ⇧+/ arrives as event.key === "?", not "/".
// A synthetic `key: "/"` event cannot happen with ⇧ held on this layout and
// would silently hide a broken chord (review finding) — these tests fire the
// keyboard entry point the way a real keyboard does.
function pressFeedbackChord() {
	fireEvent.keyDown(window, { key: "?", metaKey: true, shiftKey: true });
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

describe("LazyFeedbackDialog", () => {
	it("does not load a surface before activation", () => {
		render(<LazyFeedbackDialog />);
		expect(screen.queryByTestId("feedback-dialog-loaded")).toBeNull();
	});

	it("captures the window before the dialog is on screen", async () => {
		const order: string[] = [];
		mocks.capture.mockImplementation(async () => {
			order.push("capture");
			return png;
		});
		render(<LazyFeedbackDialog />);

		pressFeedbackChord();

		expect(await screen.findByTestId("feedback-dialog-loaded")).toBeTruthy();
		order.push("open");

		expect(order).toEqual(["capture", "open"]);
	});

	it("opens through the search dialog's request bus too, still capturing first", async () => {
		const order: string[] = [];
		mocks.capture.mockImplementation(async () => {
			order.push("capture");
			return png;
		});
		render(<LazyFeedbackDialog />);

		requestFeedback();

		expect(await screen.findByTestId("feedback-dialog-loaded")).toBeTruthy();
		order.push("open");

		expect(order).toEqual(["capture", "open"]);
	});

	it("still opens, without a screenshot, when capture is refused", async () => {
		mocks.capture.mockRejectedValue(new Error("screen_recording_permission"));
		render(<LazyFeedbackDialog />);

		pressFeedbackChord();

		const dialog = await screen.findByTestId("feedback-dialog-loaded");
		expect(dialog.textContent).toBe("false");
	});

	it("ignores a second activation while one is already in flight or already open", async () => {
		let resolveCapture: (value: typeof png) => void = () => {};
		mocks.capture.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveCapture = resolve;
				}),
		);
		render(<LazyFeedbackDialog />);

		pressFeedbackChord();
		// A second press while the first capture is still in flight must not
		// start a second capture — that would photograph the (not yet mounted,
		// but about to be) feedback form.
		pressFeedbackChord();
		expect(mocks.capture).toHaveBeenCalledTimes(1);

		resolveCapture(png);
		expect(await screen.findByTestId("feedback-dialog-loaded")).toBeTruthy();

		// Nor should pressing it again while the dialog is already open —
		// that would re-capture (photographing the open form itself) and
		// remount the dialog, discarding the user's draft (review finding).
		pressFeedbackChord();
		expect(mocks.capture).toHaveBeenCalledTimes(1);
	});

	// The in-flight guard was only ever released by the dialog closing, and
	// the dialog only opens once the capture settles. A capture that never
	// settles therefore killed the chord AND the search command for the rest
	// of the session, with nothing on screen. The user pressed a key; they
	// get the dialog, screenshot or not.
	it("opens anyway when the capture never settles, and stays usable after", async () => {
		vi.useFakeTimers();
		mocks.capture.mockImplementation(() => new Promise(() => {}));
		render(<LazyFeedbackDialog />);

		pressFeedbackChord();
		expect(screen.queryByTestId("feedback-dialog-loaded")).toBeNull();

		await act(async () => {
			vi.advanceTimersByTime(10_000);
		});
		expect(screen.getByTestId("feedback-dialog-loaded").textContent).toBe(
			"false",
		);

		// The half the name promises: closing releases the guard the hung
		// capture was holding, so the next press captures and opens normally.
		fireEvent.click(screen.getByRole("button", { name: "close" }));
		expect(screen.queryByTestId("feedback-dialog-loaded")).toBeNull();

		mocks.capture.mockResolvedValue(png);
		await act(async () => {
			pressFeedbackChord();
		});
		expect(mocks.capture).toHaveBeenCalledTimes(2);
		expect(screen.getByTestId("feedback-dialog-loaded").textContent).toBe(
			"true",
		);
	});
});
