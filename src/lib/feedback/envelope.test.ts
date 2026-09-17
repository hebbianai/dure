import { describe, expect, it } from "vitest";
import { buildEnvelope } from "@/lib/feedback/envelope";

const input = {
	kind: "bug" as const,
	body: "it froze",
	contact: "",
	deviceId: "d-abc",
	locale: "ko",
	window: { width: 1512, height: 982 },
	os: "macOS 15.5",
	arch: "aarch64",
	screenshot: { pngB64: "AAAA", width: 1512, height: 982 },
	includeScreenshot: true,
};

describe("buildEnvelope", () => {
	it("carries the screenshot when it is kept", () => {
		expect(buildEnvelope(input).attachments).toHaveLength(1);
	});

	it("omits the screenshot entirely when it is dropped", () => {
		const envelope = buildEnvelope({ ...input, includeScreenshot: false });
		expect(envelope.attachments).toEqual([]);
		expect(JSON.stringify(envelope)).not.toContain("AAAA");
	});

	it("omits an empty contact rather than sending a blank field", () => {
		expect(buildEnvelope(input).contact).toBeUndefined();
	});

	it("carries an arbitrary attachment even with no screenshot", () => {
		const envelope = buildEnvelope({
			...input,
			includeScreenshot: false,
			attachment: {
				name: "error-report.json",
				mediaType: "application/json",
				bytesB64: "eyJhIjoxfQ==",
			},
		});
		expect(envelope.attachments).toEqual([
			{
				name: "error-report.json",
				media_type: "application/json",
				bytes_b64: "eyJhIjoxfQ==",
			},
		]);
	});

	it("carries the screenshot and an arbitrary attachment together, screenshot first", () => {
		const envelope = buildEnvelope({
			...input,
			attachment: {
				name: "error-report.json",
				mediaType: "application/json",
				bytesB64: "eyJhIjoxfQ==",
			},
		});
		expect(envelope.attachments).toEqual([
			{ name: "screenshot.png", media_type: "image/png", bytes_b64: "AAAA" },
			{
				name: "error-report.json",
				media_type: "application/json",
				bytes_b64: "eyJhIjoxfQ==",
			},
		]);
	});

	it("omits the attachment entirely when it is not given", () => {
		expect(buildEnvelope(input).attachments).toEqual([
			{ name: "screenshot.png", media_type: "image/png", bytes_b64: "AAAA" },
		]);
	});
});
