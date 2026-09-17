// Pure assembly of the feedback wire envelope
// (crates/dure-feedback-intake/src/wire.rs's `Submission`). No globals, no
// clock, no IPC: every value that could vary at runtime arrives as an
// argument, so a caller can render an exact preview of the object it will
// later post and know the post will be byte-for-byte the same value.
import { configuredFrontendAppChannel } from "@/lib/platform/appChannel";
import { frontendRuntimeObservation } from "@/lib/platform/frontendRuntimeObservation";

export type FeedbackKind = "bug" | "idea" | "other" | "crash";

/** The intake's own body cap (`BODY_LIMIT` in
 *  crates/dure-feedback-intake/src/wire.rs). The dialog's input limit reads
 *  this rather than picking its own number: a field looser than the wire
 *  produces a 413 whose field is "body", which is not the attachment case,
 *  so the user gets a generic rejection behind a Retry that cannot succeed.
 *  `maxLength` counts UTF-16 units and the intake counts characters, so
 *  this bound is at or below the wire cap for every possible input. */
export const FEEDBACK_BODY_LIMIT = 8000;

/** The intake's own contact cap (`CONTACT_LIMIT` in wire.rs). Same reason as
 *  the body limit: an uncapped field turns a typo into a 413 the dialog has
 *  to recover from, and `readRememberedFeedbackContact()` can hand back a
 *  value stored before any cap existed. */
export const FEEDBACK_CONTACT_LIMIT = 200;

/** Structurally the same shape as ipc/feedback.ts's `CapturedPng` — declared
 *  locally so this pure module never imports the invoke boundary. */
export interface EnvelopeScreenshot {
	pngB64: string;
	width: number;
	height: number;
}

export interface EnvelopeWindowSize {
	width: number;
	height: number;
}

/** An arbitrary single non-screenshot attachment — for example
 *  ErrorReportDialog's `ErrorReportBundleV1` JSON. `mediaType`/`bytesB64`
 *  are camelCase here (this is the pure-assembly boundary's own shape);
 *  `buildEnvelope` maps them onto the wire's `media_type`/`bytes_b64`. */
export interface EnvelopeAttachment {
	name: string;
	mediaType: string;
	bytesB64: string;
}

/** Everything `buildEnvelope` needs for one report. `app`/`channel` are
 *  optional: when a caller omits them, `buildEnvelope` falls back to this
 *  build's own frozen `frontendRuntimeObservation.buildId` and configured
 *  channel, which never change during a running process, so the fallback
 *  is exactly as deterministic as passing them in explicitly. A caller that
 *  wants zero internal reads (for example to guarantee a preview and the
 *  later submit call share one captured value) may pass both explicitly. */
export interface EnvelopeInput {
	kind: FeedbackKind;
	body: string;
	contact: string;
	deviceId: string;
	locale: string;
	window: EnvelopeWindowSize;
	os: string;
	arch: string;
	screenshot: EnvelopeScreenshot | null;
	includeScreenshot: boolean;
	/** An arbitrary single attachment carried alongside (or instead of) the
	 *  screenshot — the intake accepts up to `wire.rs`'s
	 *  `ATTACHMENT_COUNT_LIMIT` (2) per submission. Optional: most callers
	 *  (every non-crash kind, today) never set it. */
	attachment?: EnvelopeAttachment | null;
	app?: string;
	channel?: string;
}

interface FeedbackAttachment {
	name: string;
	media_type: string;
	bytes_b64: string;
}

interface FeedbackEnvelopeEnv {
	app: string;
	channel: string;
	os: string;
	arch: string;
	locale: string;
	window: string;
}

/** Mirrors `crates/dure-feedback-intake/src/wire.rs`'s `Submission` exactly —
 *  field names and shape included, since the intake deserializes this as-is. */
export interface FeedbackEnvelope {
	schema: 1;
	kind: FeedbackKind;
	body: string;
	contact?: string;
	env: FeedbackEnvelopeEnv;
	device: string;
	attachments: FeedbackAttachment[];
}

/** The screenshot attachment always uses this fixed, safe name — never a name
 *  derived from user input. The intake rejects anything outside
 *  `[A-Za-z0-9._-]` (limits.rs's `ATTACHMENT_NAME_LIMIT` check), so a name
 *  built from user text could be rejected or, worse, contain `../`. */
const SCREENSHOT_ATTACHMENT_NAME = "screenshot.png";

export function buildEnvelope(input: EnvelopeInput): FeedbackEnvelope {
	const trimmedContact = input.contact.trim();
	const attachments: FeedbackAttachment[] = [
		...(input.includeScreenshot && input.screenshot
			? [
					{
						name: SCREENSHOT_ATTACHMENT_NAME,
						media_type: "image/png",
						bytes_b64: input.screenshot.pngB64,
					},
				]
			: []),
		...(input.attachment
			? [
					{
						name: input.attachment.name,
						media_type: input.attachment.mediaType,
						bytes_b64: input.attachment.bytesB64,
					},
				]
			: []),
	];

	return {
		schema: 1,
		kind: input.kind,
		body: input.body,
		...(trimmedContact.length > 0 ? { contact: trimmedContact } : {}),
		env: {
			app: input.app ?? frontendRuntimeObservation.buildId,
			channel: input.channel ?? configuredFrontendAppChannel() ?? "unset",
			os: input.os,
			arch: input.arch,
			locale: input.locale,
			window: `${input.window.width}x${input.window.height}`,
		},
		device: input.deviceId,
		attachments,
	};
}
