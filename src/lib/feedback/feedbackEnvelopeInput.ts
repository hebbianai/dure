// Assembles buildEnvelope's EnvelopeInput from the feedback dialog's current
// draft state. Pulled out of FeedbackDialog.tsx so the normal Send path and
// the "send without screenshot" retry (after a 413 that named the attachment
// as too large) construct the exact same shape from the exact same code —
// without this, a field added to EnvelopeInput only gets threaded through
// one of the two call sites, and the retry silently posts something the
// preview never showed (review finding).
import type {
	EnvelopeAttachment,
	EnvelopeInput,
	EnvelopeScreenshot,
	EnvelopeWindowSize,
	FeedbackKind,
} from "@/lib/feedback/envelope";

/** The launcher's capture outcome, in the shape this module needs — pure
 *  data, structurally identical to (but independent of) the component-level
 *  `FeedbackCaptureResult` in FeedbackDialog.tsx, so this pure module never
 *  imports a component. */
type FeedbackEnvelopeCapture =
	| { readonly ok: true; readonly screenshot: EnvelopeScreenshot }
	| { readonly ok: false; readonly reason: string };

export interface FeedbackEnvelopeInputParams {
	kind: FeedbackKind;
	body: string;
	contact: string;
	deviceId: string;
	locale: string;
	window: EnvelopeWindowSize;
	os: string;
	arch: string;
	/** Omit entirely when the caller never attempts a screenshot capture at
	 *  all — for example ErrorReportDialog's crash reports, which carry the
	 *  incident bundle as `attachment` instead and take no screenshot (the
	 *  window that just crashed has nothing useful to photograph). The
	 *  resulting `EnvelopeInput.screenshot` is `null` either way. */
	capture?: FeedbackEnvelopeCapture;
	includeScreenshot: boolean;
	/** An arbitrary single attachment, passed straight through to
	 *  `buildEnvelope` — see `EnvelopeInput.attachment`. */
	attachment?: EnvelopeAttachment | null;
	app: string;
	channel: string;
}

export function feedbackEnvelopeInput(
	params: FeedbackEnvelopeInputParams,
): EnvelopeInput {
	const { capture, ...rest } = params;
	return {
		...rest,
		screenshot:
			capture?.ok === true
				? {
						pngB64: capture.screenshot.pngB64,
						width: capture.screenshot.width,
						height: capture.screenshot.height,
					}
				: null,
	};
}
