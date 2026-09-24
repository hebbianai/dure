// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderFeedbackPreview } from "@/lib/feedback/feedbackPreview";
import { setLang } from "@/lib/i18n";

const mocks = vi.hoisted(() => ({
	writeText: vi.fn(),
	feedbackEnvironment: vi.fn(),
	submitFeedback: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
	writeText: mocks.writeText,
}));
vi.mock("@/lib/ipc/feedback", async () => {
	const actual =
		await vi.importActual<typeof import("@/lib/ipc/feedback")>(
			"@/lib/ipc/feedback",
		);
	return {
		...actual,
		feedbackEnvironment: mocks.feedbackEnvironment,
		submitFeedback: mocks.submitFeedback,
	};
});

import {
	type FeedbackCaptureResult,
	FeedbackDialog,
} from "@/components/feedback/FeedbackDialog";
import { FeedbackSubmitError } from "@/lib/ipc/feedback";

const okCapture: FeedbackCaptureResult = {
	ok: true,
	screenshot: { pngB64: "c2NyZWVuc2hvdA==", width: 100, height: 80 },
};

beforeEach(() => {
	vi.clearAllMocks();
	setLang("en");
	mocks.feedbackEnvironment.mockResolvedValue({
		os: "macOS 14.5",
		arch: "arm64",
	});
	mocks.writeText.mockResolvedValue(undefined);
	window.localStorage.clear();
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	window.localStorage.clear();
});

function typeBody(text: string) {
	fireEvent.change(screen.getByRole("textbox", { name: /what happened/i }), {
		target: { value: text },
	});
}

/** Send stays disabled until feedbackEnvironment() resolves (a submission
 *  before then would post os:""/arch:"" — see FeedbackDialog's `environment`
 *  state comment). Every test that clicks Send waits for this first. */
async function waitForEnvironmentReady() {
	await waitFor(() =>
		expect(screen.getByTestId("feedback-preview").textContent).toContain(
			"macOS 14.5",
		),
	);
}

/** The preview shown right before Send is what buildEnvelope actually
 *  produced, run through the same redaction `renderFeedbackPreview` applies
 *  for display (see feedbackPreview.test.ts for the proof that redaction is
 *  the *only* difference from the raw envelope). Comparing the *submitted*
 *  argument through that same pure function — rather than re-deriving an
 *  expected object by hand — is what "assert against the actual argument"
 *  means once the preview is no longer byte-identical to the payload. */
function expectPreviewMatchedWhatWasSent(
	previewedBeforeSend: string,
	sentEnvelope: unknown,
) {
	expect(
		renderFeedbackPreview(
			sentEnvelope as Parameters<typeof renderFeedbackPreview>[0],
		),
	).toBe(previewedBeforeSend);
}

describe("FeedbackDialog", () => {
	it("keeps the draft and waits all 730 seconds before allowing a manual retry", async () => {
		mocks.submitFeedback.mockRejectedValueOnce(
			new FeedbackSubmitError("rate_limited", "rate limited", undefined, 730),
		);
		render(<FeedbackDialog open onOpenChange={vi.fn()} capture={okCapture} />);
		typeBody("account switch failed");
		await waitForEnvironmentReady();
		vi.useFakeTimers();
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
		});
		expect(screen.getByText(/730 seconds/)).toBeTruthy();
		const retry = () =>
			screen.getByRole<HTMLButtonElement>("button", { name: /^retry$/i });
		expect(retry().disabled).toBe(true);
		typeBody("account switch failed — more details");
		expect(retry().disabled).toBe(true);
		await act(async () => {
			vi.advanceTimersByTime(720_000);
		});
		expect(screen.getByText(/10 seconds/)).toBeTruthy();
		fireEvent.click(retry());
		expect(mocks.submitFeedback).toHaveBeenCalledTimes(1);
		// A suspended WebView may resume without receiving every timer tick.
		vi.setSystemTime(Date.now() + 60_000);
		await act(async () => {
			vi.advanceTimersByTime(1_000);
		});
		expect(retry().disabled).toBe(false);
		expect(screen.getByText(/can retry now/i)).toBeTruthy();
		expect(mocks.submitFeedback).toHaveBeenCalledTimes(1);
		mocks.submitFeedback.mockResolvedValueOnce({ reference: "f-retried" });
		await act(async () => {
			fireEvent.click(retry());
		});
		expect(mocks.submitFeedback).toHaveBeenLastCalledWith(
			expect.objectContaining({ body: "account switch failed — more details" }),
		);
		expect(screen.getByText(/f-retried/)).toBeTruthy();
	});

	it("previews exactly what it will send (redacted attachment bytes aside, which feedbackPreview.test.ts proves is the only difference)", async () => {
		mocks.submitFeedback.mockResolvedValue({ reference: "ref-1" });
		render(<FeedbackDialog open onOpenChange={vi.fn()} capture={okCapture} />);

		typeBody("it froze");
		await waitFor(() => {
			const text = screen.getByTestId("feedback-preview").textContent ?? "";
			expect(text).toContain("it froze");
			expect(text).toContain("macOS 14.5");
		});
		const previewedBeforeSend =
			screen.getByTestId("feedback-preview").textContent ?? "";

		fireEvent.click(screen.getByRole("button", { name: /send/i }));

		await waitFor(() => expect(mocks.submitFeedback).toHaveBeenCalledTimes(1));
		expectPreviewMatchedWhatWasSent(
			previewedBeforeSend,
			mocks.submitFeedback.mock.calls[0][0],
		);
	});

	it("disables Send until the environment read resolves, so a fast submission can never post empty os/arch", async () => {
		let resolveEnvironment: (value: { os: string; arch: string }) => void =
			() => {};
		mocks.feedbackEnvironment.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveEnvironment = resolve;
				}),
		);
		render(<FeedbackDialog open onOpenChange={vi.fn()} capture={okCapture} />);
		typeBody("it froze");

		const sendButton = screen.getByRole("button", {
			name: /send/i,
		}) as HTMLButtonElement;
		expect(sendButton.disabled).toBe(true);

		resolveEnvironment({ os: "macOS 14.5", arch: "arm64" });
		await waitFor(() => expect(sendButton.disabled).toBe(false));
	});

	it("keeps the draft and offers retry when the send fails, and the retry still matches its own preview", async () => {
		mocks.submitFeedback.mockRejectedValueOnce(
			new FeedbackSubmitError("network", "feedback request failed: boom"),
		);
		render(<FeedbackDialog open onOpenChange={vi.fn()} capture={okCapture} />);

		typeBody("it froze on save");
		await waitForEnvironmentReady();
		fireEvent.click(screen.getByRole("button", { name: /send/i }));

		const retryButton = await screen.findByRole("button", { name: /retry/i });
		const bodyField = screen.getByRole("textbox", {
			name: /what happened/i,
		}) as HTMLTextAreaElement;
		expect(bodyField.value).toBe("it froze on save");

		mocks.submitFeedback.mockResolvedValueOnce({ reference: "ref-2" });
		const previewedBeforeRetry =
			screen.getByTestId("feedback-preview").textContent ?? "";
		fireEvent.click(retryButton);
		await waitFor(() => expect(mocks.submitFeedback).toHaveBeenCalledTimes(2));
		expect(bodyField.value).toBe("it froze on save");
		expectPreviewMatchedWhatWasSent(
			previewedBeforeRetry,
			mocks.submitFeedback.mock.calls[1][0],
		);
	});

	it("points at Screen Recording permission when capture is refused", () => {
		render(
			<FeedbackDialog
				open
				onOpenChange={vi.fn()}
				capture={{ ok: false, reason: "screen_recording_permission" }}
			/>,
		);

		expect(screen.getAllByText(/screen recording/i).length).toBeGreaterThan(0);
	});

	it("shows a generic message for a non-permission capture failure", () => {
		render(
			<FeedbackDialog
				open
				onOpenChange={vi.fn()}
				capture={{ ok: false, reason: "window_missing" }}
			/>,
		);

		expect(screen.queryByText(/screen recording/i)).toBeNull();
		expect(screen.getByText(/window_missing/)).toBeTruthy();
	});

	it("dropping the screenshot removes it from the submitted envelope entirely, matching its own preview", async () => {
		mocks.submitFeedback.mockResolvedValue({ reference: "ref-3" });
		render(<FeedbackDialog open onOpenChange={vi.fn()} capture={okCapture} />);

		typeBody("no screenshot please");
		await waitForEnvironmentReady();
		fireEvent.click(screen.getByRole("switch"));
		const previewedBeforeSend =
			screen.getByTestId("feedback-preview").textContent ?? "";
		fireEvent.click(screen.getByRole("button", { name: /send/i }));

		await waitFor(() => expect(mocks.submitFeedback).toHaveBeenCalledTimes(1));
		const sent = mocks.submitFeedback.mock.calls[0][0];
		expect(sent.attachments).toEqual([]);
		expectPreviewMatchedWhatWasSent(previewedBeforeSend, sent);
	});

	it("'send without screenshot' after a 413 posts attachments:[] matching the envelope the preview shows once it re-renders", async () => {
		mocks.submitFeedback.mockRejectedValueOnce(
			new FeedbackSubmitError(
				"rejected",
				"feedback rejected: attachment bytes too large",
				"attachment bytes",
			),
		);
		mocks.submitFeedback.mockResolvedValueOnce({ reference: "ref-4" });
		render(<FeedbackDialog open onOpenChange={vi.fn()} capture={okCapture} />);

		typeBody("huge screenshot");
		await waitForEnvironmentReady();
		fireEvent.click(screen.getByRole("button", { name: /send/i }));

		const sendWithoutScreenshotButton = await screen.findByRole("button", {
			name: /send without screenshot/i,
		});
		fireEvent.click(sendWithoutScreenshotButton);

		await waitFor(() => expect(mocks.submitFeedback).toHaveBeenCalledTimes(2));
		const sent = mocks.submitFeedback.mock.calls[1][0];
		expect(sent.attachments).toEqual([]);

		// The switch flips off as a side effect, so the dialog's own preview
		// (once it catches up) must describe the same screenshot-less report
		// that was actually posted.
		await waitFor(() => {
			expectPreviewMatchedWhatWasSent(
				screen.getByTestId("feedback-preview").textContent ?? "",
				sent,
			);
		});
	});

	// The intake documents 400/413 as unretryable: the same payload can never
	// be accepted. Offering Retry there re-posted it byte for byte and spent
	// one of the device's five hourly submissions on a request already known
	// to fail.
	it("does not offer Retry after a rejection the intake can never accept", async () => {
		mocks.submitFeedback.mockRejectedValueOnce(
			new FeedbackSubmitError("rejected", "feedback rejected: empty body"),
		);
		render(<FeedbackDialog open onOpenChange={vi.fn()} capture={okCapture} />);

		typeBody("it froze on save");
		await waitForEnvironmentReady();
		fireEvent.click(screen.getByRole("button", { name: /send/i }));

		await waitFor(() => expect(mocks.submitFeedback).toHaveBeenCalledTimes(1));
		await waitFor(() =>
			expect(screen.getByText(/couldn't accept this report/i)).toBeTruthy(),
		);
		expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
		expect(
			(screen.getByRole("button", { name: /send/i }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
	});

	// A 413 naming the attachment IS retryable without it — that branch has
	// its own button and must survive the change above.
	it("still offers the screenshot-drop retry after an attachment 413", async () => {
		mocks.submitFeedback.mockRejectedValueOnce(
			new FeedbackSubmitError(
				"rejected",
				"feedback rejected: attachment bytes too large",
				"attachment bytes",
			),
		);
		render(<FeedbackDialog open onOpenChange={vi.fn()} capture={okCapture} />);

		typeBody("it froze on save");
		await waitForEnvironmentReady();
		fireEvent.click(screen.getByRole("button", { name: /send/i }));

		expect(
			await screen.findByRole("button", { name: /send without screenshot/i }),
		).toBeTruthy();
	});

	it("stops offering Send once the report has been accepted", async () => {
		mocks.submitFeedback.mockResolvedValueOnce({ reference: "f-8K2QP" });
		render(<FeedbackDialog open onOpenChange={vi.fn()} capture={okCapture} />);

		typeBody("it froze on save");
		await waitForEnvironmentReady();
		fireEvent.click(screen.getByRole("button", { name: /send/i }));

		const sent = await screen.findByRole("button", { name: /^sent$/i });
		expect((sent as HTMLButtonElement).disabled).toBe(true);
		fireEvent.click(sent);
		expect(mocks.submitFeedback).toHaveBeenCalledTimes(1);
	});

	// `maxLength` counts UTF-16 units and the intake counts characters, so
	// 8000 here is at or below the wire cap for every input. At 8192 a body
	// between the two produced a 413 whose field is "body" — not the
	// attachment case, so the user saw a generic rejection.
	it("caps the body where the intake does, not above it", async () => {
		render(<FeedbackDialog open onOpenChange={vi.fn()} capture={okCapture} />);
		const field = screen.getByRole("textbox", {
			name: /what happened/i,
		}) as HTMLTextAreaElement;
		expect(field.maxLength).toBe(8000);
	});

	// A 64px object-cover thumbnail is not a review surface: the one part of
	// the payload the notice cannot promise anything about was the one part
	// the user could not actually look at.
	it("shows the screenshot at full size on demand", async () => {
		render(<FeedbackDialog open onOpenChange={vi.fn()} capture={okCapture} />);

		expect(screen.queryByAltText(/full size/i)).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: /view full size/i }));

		const full = (await screen.findByAltText(/full size/i)) as HTMLImageElement;
		expect(full.src).toContain(okCapture.ok ? okCapture.screenshot.pngB64 : "");
	});

	// A 413 naming `contact` is the one rejection the user can fix: shorten
	// it and send again. `readRememberedFeedbackContact()` can hand back a
	// value stored before the field was capped, so this arrives with no
	// typing at all. Treating it as permanent killed Send for the session,
	// and nothing cleared the failure when the draft changed underneath it.
	it("recovers from an over-long contact once it is shortened", async () => {
		mocks.submitFeedback.mockRejectedValueOnce(
			new FeedbackSubmitError(
				"rejected",
				"feedback rejected: contact too large",
				"contact",
			),
		);
		render(<FeedbackDialog open onOpenChange={vi.fn()} capture={okCapture} />);

		typeBody("it froze on save");
		const contactField = screen.getByRole("textbox", { name: /contact/i });
		fireEvent.change(contactField, { target: { value: "x".repeat(201) } });
		await waitForEnvironmentReady();
		fireEvent.click(screen.getByRole("button", { name: /send/i }));

		await waitFor(() => expect(mocks.submitFeedback).toHaveBeenCalledTimes(1));

		fireEvent.change(contactField, { target: { value: "me@example.test" } });
		mocks.submitFeedback.mockResolvedValueOnce({ reference: "f-8K2QP" });
		const sendButton = screen.getByRole("button", {
			name: /send/i,
		}) as HTMLButtonElement;
		expect(sendButton.disabled).toBe(false);
		fireEvent.click(sendButton);

		await waitFor(() => expect(mocks.submitFeedback).toHaveBeenCalledTimes(2));
		expect(mocks.submitFeedback.mock.calls[1][0].contact).toBe(
			"me@example.test",
		);
		expect(await screen.findByRole("button", { name: /^sent$/i })).toBeTruthy();
	});

	it("caps the contact where the intake does", () => {
		render(<FeedbackDialog open onOpenChange={vi.fn()} capture={okCapture} />);
		const contactField = screen.getByRole("textbox", {
			name: /contact/i,
		}) as HTMLInputElement;
		expect(contactField.maxLength).toBe(200);
	});

	// C1 again, reintroduced by the sentence that fixed it: the notice
	// asserted a screenshot was going and told the reader to click the
	// thumbnail, on every render — including the states where capture failed
	// and an Alert stands where the thumbnail would be.
	it("does not claim a screenshot when there is none to send", () => {
		render(
			<FeedbackDialog
				open
				onOpenChange={vi.fn()}
				capture={{ ok: false, reason: "capture_timed_out" }}
			/>,
		);
		expect(screen.getByText(/no screenshot is attached/i)).toBeTruthy();
		expect(screen.queryByText(/click the thumbnail/i)).toBeNull();
	});

	it("says the screenshot is going while it is still attached, and stops when it is switched off", () => {
		render(<FeedbackDialog open onOpenChange={vi.fn()} capture={okCapture} />);
		expect(screen.getByText(/click the thumbnail/i)).toBeTruthy();

		fireEvent.click(screen.getByRole("switch", { name: /screenshot/i }));

		expect(screen.getByText(/no screenshot is attached/i)).toBeTruthy();
		expect(screen.queryByText(/click the thumbnail/i)).toBeNull();
	});

	it("reports success after copying the report", async () => {
		render(<FeedbackDialog open onOpenChange={vi.fn()} capture={okCapture} />);

		fireEvent.click(screen.getByRole("button", { name: /copy report/i }));

		await waitFor(() => expect(mocks.writeText).toHaveBeenCalledTimes(1));
		expect(await screen.findByRole("status")).toBeTruthy();
		expect(screen.getByRole("status").textContent).toMatch(/copied/i);
	});

	it("reports failure, without losing the draft, when copying the report fails", async () => {
		mocks.writeText.mockRejectedValueOnce(new Error("clipboard denied"));
		render(<FeedbackDialog open onOpenChange={vi.fn()} capture={okCapture} />);
		typeBody("keep me");

		fireEvent.click(screen.getByRole("button", { name: /copy report/i }));

		await waitFor(() =>
			expect(screen.getByRole("status").textContent).toMatch(/couldn't copy/i),
		);
		expect(
			(
				screen.getByRole("textbox", {
					name: /what happened/i,
				}) as HTMLTextAreaElement
			).value,
		).toBe("keep me");
	});
});
