import { describe, expect, it } from "vitest";
import type { FeedbackEnvelope } from "@/lib/feedback/envelope";
import { renderFeedbackPreview } from "@/lib/feedback/feedbackPreview";

function envelopeWithAttachment(bytesB64: string): FeedbackEnvelope {
	return {
		schema: 1,
		kind: "bug",
		body: "it froze",
		env: {
			app: "0.2.19",
			channel: "stable",
			os: "macOS 14.5",
			arch: "arm64",
			locale: "en",
			window: "1200x800",
		},
		device: "device-1",
		attachments: [
			{ name: "screenshot.png", media_type: "image/png", bytes_b64: bytesB64 },
		],
	};
}

describe("renderFeedbackPreview", () => {
	it("is byte-for-byte identical to the full JSON when there is no attachment", () => {
		const envelope: FeedbackEnvelope = {
			...envelopeWithAttachment(""),
			attachments: [],
		};
		expect(renderFeedbackPreview(envelope)).toBe(
			JSON.stringify(envelope, null, 2),
		);
	});

	it("changes nothing except the attachment's bytes_b64 line", () => {
		// "QUJD" decodes to "ABC" — 3 bytes, no padding.
		const envelope = envelopeWithAttachment("QUJD");
		const full = JSON.stringify(envelope, null, 2);
		const preview = renderFeedbackPreview(envelope);

		const fullLines = full.split("\n");
		const previewLines = preview.split("\n");
		expect(previewLines.length).toBe(fullLines.length);

		const changedLines = previewLines
			.map((line, index) => ({ line, index }))
			.filter(({ line, index }) => line !== fullLines[index]);

		expect(changedLines).toHaveLength(1);
		expect(changedLines[0].line).toContain("bytes_b64");
		expect(changedLines[0].line).toContain("image/png");
		expect(changedLines[0].line).toContain("3 bytes");
		expect(changedLines[0].line).not.toContain("QUJD");
	});

	it("computes the decoded byte length from base64 padding, not the encoded length", () => {
		// "QUI=" decodes to "AB" — 2 bytes despite 4 base64 characters.
		const preview = renderFeedbackPreview(envelopeWithAttachment("QUI="));
		expect(preview).toContain("2 bytes");
	});

	it("submit is unaffected — this module never touches the real envelope object", () => {
		const envelope = envelopeWithAttachment("QUJD");
		renderFeedbackPreview(envelope);
		expect(envelope.attachments[0].bytes_b64).toBe("QUJD");
	});
});
