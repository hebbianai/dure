import { describe, expect, it } from "vitest";
import { feedbackEnvelopeInput } from "@/lib/feedback/feedbackEnvelopeInput";

const BASE = {
	kind: "bug" as const,
	body: "it froze",
	contact: "",
	deviceId: "device-1",
	locale: "en",
	window: { width: 1200, height: 800 },
	os: "macOS 14.5",
	arch: "arm64",
	includeScreenshot: true,
	app: "0.2.19",
	channel: "stable",
};

describe("feedbackEnvelopeInput", () => {
	it("maps a successful capture to a screenshot", () => {
		const input = feedbackEnvelopeInput({
			...BASE,
			capture: {
				ok: true,
				screenshot: { pngB64: "abc", width: 10, height: 10 },
			},
		});
		expect(input.screenshot).toEqual({ pngB64: "abc", width: 10, height: 10 });
	});

	it("maps a failed capture to a null screenshot regardless of includeScreenshot", () => {
		const input = feedbackEnvelopeInput({
			...BASE,
			includeScreenshot: true,
			capture: { ok: false, reason: "screen_recording_permission" },
		});
		expect(input.screenshot).toBeNull();
	});

	it("keeps the raw screenshot even when includeScreenshot is false — buildEnvelope owns the attachment gate", () => {
		const input = feedbackEnvelopeInput({
			...BASE,
			includeScreenshot: false,
			capture: {
				ok: true,
				screenshot: { pngB64: "abc", width: 10, height: 10 },
			},
		});
		expect(input.screenshot).toEqual({ pngB64: "abc", width: 10, height: 10 });
		expect(input.includeScreenshot).toBe(false);
	});

	it("maps an omitted capture (no screenshot ever attempted) to a null screenshot", () => {
		const input = feedbackEnvelopeInput({ ...BASE });
		expect(input.screenshot).toBeNull();
	});

	it("passes an arbitrary attachment through unchanged, alongside an omitted capture", () => {
		const attachment = {
			name: "error-report.json",
			mediaType: "application/json",
			bytesB64: "eyJhIjoxfQ==",
		};
		const input = feedbackEnvelopeInput({ ...BASE, attachment });
		expect(input.attachment).toEqual(attachment);
		expect(input.screenshot).toBeNull();
	});

	it("passes every other field through unchanged", () => {
		const input = feedbackEnvelopeInput({
			...BASE,
			capture: { ok: false, reason: "window_missing" },
		});
		expect(input).toMatchObject({
			kind: "bug",
			body: "it froze",
			contact: "",
			deviceId: "device-1",
			locale: "en",
			window: { width: 1200, height: 800 },
			os: "macOS 14.5",
			arch: "arm64",
			includeScreenshot: true,
			app: "0.2.19",
			channel: "stable",
		});
	});
});
