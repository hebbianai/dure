// Pure mapping from an ErrorReportBundleV1 (errorIncident.ts's local
// review/export format — the JSON ErrorReportDialog previews, copies and
// saves) to the two pieces buildEnvelope's `kind: "crash"` path needs: a
// stable non-empty body and the bundle itself as a single JSON attachment.
// No IPC, no clock, no randomness — the same bundle in always produces the
// same output out, so a caller can build this once per render and be sure
// the on-screen preview and the later submit describe the same thing.
import type { EnvelopeAttachment } from "@/lib/feedback/envelope";
import { bytesToBase64 } from "@/lib/platform/base64";
import {
	type ErrorReportBundleV1,
	serializeErrorReportBundle,
} from "@/lib/platform/errorIncident";

/** Fixed, safe literal name for the crash bundle attachment — never derived
 *  from user input. The intake's `safe_attachment_basename`
 *  (crates/dure-feedback-intake/src/sink.rs) rejects anything outside
 *  `[A-Za-z0-9._-]{1,64}` with at least one non-dot character; a name built
 *  from user text could fail that check or, worse, contain `../`. */
const CRASH_BUNDLE_ATTACHMENT_NAME = "error-report.json";

/** The body the intake requires to be non-empty
 *  (`Submission::parse` in wire.rs rejects an all-whitespace body).
 *
 * Prefers the bundle's own reproduction notes — already redacted by
 * `buildErrorReportBundle` the same way the rest of the bundle is, so this
 * plain-text field never carries what the JSON attachment already strips.
 * When the user left notes blank (or whitespace-only), falls back to the
 * error's name and message: both are always non-empty
 * (`errorDetails` in errorIncident.ts never leaves either blank) and stable
 * for a given incident, so retrying an empty-notes report posts the same
 * body twice rather than a fresh placeholder each time.
 */
export function crashReportBody(bundle: ErrorReportBundleV1): string {
	const notes = bundle.reproduction.notes.trim();
	if (notes.length > 0) return notes;
	return `${bundle.incident.error.name}: ${bundle.incident.error.message}`;
}

/** The bundle's exact JSON (the same text Copy and Save use), base64-encoded
 *  as the crash report's single attachment. */
export function crashReportAttachment(
	bundle: ErrorReportBundleV1,
): EnvelopeAttachment {
	const json = serializeErrorReportBundle(bundle);
	return {
		name: CRASH_BUNDLE_ATTACHMENT_NAME,
		mediaType: "application/json",
		bytesB64: bytesToBase64(new TextEncoder().encode(json)),
	};
}
