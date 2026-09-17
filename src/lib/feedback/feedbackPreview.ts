// Renders a FeedbackEnvelope for on-screen display. Identical to
// `JSON.stringify(envelope, null, 2)` except each attachment's `bytes_b64`
// is replaced with a short, labelled marker naming its media type and
// decoded byte length.
//
// The attachment payload can run 0.3-1.4 MB of base64: re-serializing and
// re-flowing that (inside a `break-all` <pre>) on every keystroke made the
// preview itself the performance cost on the app's own bug-report path, and
// a preview that is 99% base64 is unreadable by the person it exists for —
// the thumbnail already shows the image. `submitFeedback` still posts the
// real, un-redacted envelope this module never touches; only the rendered
// preview differs, and only in this one field.
import type { FeedbackEnvelope } from "@/lib/feedback/envelope";

/** Decoded byte length of a base64 string, without decoding it — base64
 *  encodes 3 bytes as 4 characters, with 1-2 trailing `=` padding characters
 *  standing in for bytes that don't exist. */
function decodedByteLength(base64: string): number {
	const withoutPadding = base64.replace(/=+$/, "");
	const padding = base64.length - withoutPadding.length;
	return Math.floor((base64.length * 3) / 4) - padding;
}

function attachmentBytesMarker(mediaType: string, byteLength: number): string {
	return `<${mediaType}, ${byteLength} bytes, omitted from preview>`;
}

/** The exact JSON that will be posted, except every attachment's
 *  `bytes_b64` is replaced with `attachmentBytesMarker(...)`. */
export function renderFeedbackPreview(envelope: FeedbackEnvelope): string {
	const redacted: FeedbackEnvelope = {
		...envelope,
		attachments: envelope.attachments.map((attachment) => ({
			...attachment,
			bytes_b64: attachmentBytesMarker(
				attachment.media_type,
				decodedByteLength(attachment.bytes_b64),
			),
		})),
	};
	return JSON.stringify(redacted, null, 2);
}
