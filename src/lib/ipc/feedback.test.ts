import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeedbackEnvelope } from "@/lib/feedback/envelope";
import {
	FeedbackSubmitError,
	feedbackCaptureMainWindow,
	feedbackEnvironment,
	submitFeedback,
} from "@/lib/ipc/feedback";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

const envelope: FeedbackEnvelope = {
	schema: 1,
	kind: "bug",
	body: "it froze",
	env: {
		app: "0.2.19",
		channel: "beta",
		os: "macOS 15.5",
		arch: "aarch64",
		locale: "ko",
		window: "1512x982",
	},
	device: "d-abc",
	attachments: [],
};

/** A minimal Response stand-in — only `status` and `json()` are used by
 *  submitFeedback. */
function jsonResponse(status: number, body: unknown): Response {
	return { status, json: async () => body } as Response;
}

beforeEach(() => {
	invokeMock.mockReset();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("feedbackCaptureMainWindow", () => {
	it("resolves with whatever invoke resolves", async () => {
		const png = { pngB64: "AAAA", width: 1512, height: 982 };
		invokeMock.mockResolvedValueOnce(png);
		await expect(feedbackCaptureMainWindow()).resolves.toEqual(png);
		expect(invokeMock).toHaveBeenCalledWith("feedback_capture_main_window");
	});

	it("propagates a rejection code unchanged, never wrapped in prose", async () => {
		invokeMock.mockRejectedValueOnce("screen_recording_permission");
		await expect(feedbackCaptureMainWindow()).rejects.toBe(
			"screen_recording_permission",
		);
	});
});

describe("feedbackEnvironment", () => {
	it("resolves with whatever invoke resolves", async () => {
		const info = { os: "macOS 15.5", arch: "aarch64" };
		invokeMock.mockResolvedValueOnce(info);
		await expect(feedbackEnvironment()).resolves.toEqual(info);
		expect(invokeMock).toHaveBeenCalledWith("feedback_environment");
	});

	// Outside a Tauri webview — browser-mode `pnpm dev`, the very path
	// VITE_DURE_FEEDBACK_ENDPOINT exists to serve — invoke rejects. Both
	// dialogs gate Send on this value resolving, so the rejection left Send
	// permanently disabled with nothing on screen saying why, and the
	// rejection itself unhandled. An unknown machine is a worse report than
	// a real one, not a reason to refuse to send one.
	it("falls back to an unknown environment instead of rejecting", async () => {
		invokeMock.mockRejectedValueOnce(new Error("not a tauri webview"));
		await expect(feedbackEnvironment()).resolves.toEqual({
			os: "unknown",
			arch: "unknown",
		});
	});
});

describe("submitFeedback", () => {
	it("resolves the reference on 201, posting to the default endpoint", async () => {
		const fetchMock = vi.fn(async () => jsonResponse(201, { id: "f-8K2QP" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(submitFeedback(envelope)).resolves.toEqual({
			reference: "f-8K2QP",
		});

		expect(fetchMock).toHaveBeenCalledWith(
			"https://dure-feedback.fly.dev/v1/feedback",
			expect.objectContaining({
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(envelope),
			}),
		);
	});

	it("throws a temporary error on a malformed 201 body (no id)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse(201, {})),
		);

		const failure = await submitFeedback(envelope).catch((error) => error);
		expect(failure).toBeInstanceOf(FeedbackSubmitError);
		expect((failure as FeedbackSubmitError).kind).toBe("temporary");
	});

	it("throws a rejected error on 400, without a field", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse(400, {
					error: "INVALID_SUBMISSION",
					message: "empty body",
				}),
			),
		);

		const failure = await submitFeedback(envelope).catch((error) => error);
		expect(failure).toBeInstanceOf(FeedbackSubmitError);
		expect((failure as FeedbackSubmitError).kind).toBe("rejected");
		expect((failure as FeedbackSubmitError).field).toBeUndefined();
		expect((failure as FeedbackSubmitError).message).toContain("empty body");
	});

	it("throws a rejected error on 413 and carries the intake's field", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse(413, {
					error: "PAYLOAD_TOO_LARGE",
					field: "attachment bytes",
				}),
			),
		);

		const failure = await submitFeedback(envelope).catch((error) => error);
		expect(failure).toBeInstanceOf(FeedbackSubmitError);
		expect((failure as FeedbackSubmitError).kind).toBe("rejected");
		expect((failure as FeedbackSubmitError).field).toBe("attachment bytes");
	});

	it("throws a rejected error on 413 with no field when the body carries none", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse(413, { error: "PAYLOAD_TOO_LARGE" })),
		);

		const failure = await submitFeedback(envelope).catch((error) => error);
		expect(failure).toBeInstanceOf(FeedbackSubmitError);
		expect((failure as FeedbackSubmitError).kind).toBe("rejected");
		expect((failure as FeedbackSubmitError).field).toBeUndefined();
	});

	it("throws a rate_limited error on 429", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse(429, { error: "RATE_LIMITED" })),
		);

		const failure = await submitFeedback(envelope).catch((error) => error);
		expect(failure).toBeInstanceOf(FeedbackSubmitError);
		expect((failure as FeedbackSubmitError).kind).toBe("rate_limited");
	});

	it("throws a temporary error on 503", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse(503, { error: "DELIVERY_FAILED" })),
		);

		const failure = await submitFeedback(envelope).catch((error) => error);
		expect(failure).toBeInstanceOf(FeedbackSubmitError);
		expect((failure as FeedbackSubmitError).kind).toBe("temporary");
	});

	it("throws a network error when fetch itself rejects", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("Failed to fetch");
			}),
		);

		const failure = await submitFeedback(envelope).catch((error) => error);
		expect(failure).toBeInstanceOf(FeedbackSubmitError);
		expect((failure as FeedbackSubmitError).kind).toBe("network");
	});
});
