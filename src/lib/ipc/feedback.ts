// invoke() wrappers for the in-app feedback pipeline. This directory is the
// only place invoke() may be called (architecture fitness gate); pure
// envelope assembly lives in src/lib/feedback/envelope.ts.
import { invoke } from "@tauri-apps/api/core";
import type { FeedbackEnvelope } from "@/lib/feedback/envelope";

/** Mirrors src-tauri/src/feedback_capture.rs's `CapturedPng`
 *  (`#[serde(rename_all = "camelCase")]`, so the wire keys are these). */
export interface CapturedPng {
	pngB64: string;
	width: number;
	height: number;
}

/** Mirrors src-tauri/src/feedback_capture.rs's `FeedbackEnvironment`. */
export interface FeedbackEnvironmentInfo {
	os: string;
	arch: string;
}

/**
 * Screenshots the app's own main window for a bug report attachment.
 *
 * Rejects with one of a fixed set of stable string codes — see
 * feedback_capture.rs's doc comments for the exact list (for example
 * "screen_recording_permission", "unsupported_platform", "window_missing").
 * The dialog branches on that exact string, so this wrapper must never wrap
 * the rejection in prose or translate it into a different value.
 */
export function feedbackCaptureMainWindow(): Promise<CapturedPng> {
	return invoke<CapturedPng>("feedback_capture_main_window");
}

/**
 * Reports this machine's OS name/version and CPU architecture. Never
 * rejects — which is now enforced here rather than merely asserted.
 *
 * Outside a Tauri webview (browser-mode `pnpm dev`, the very path
 * `VITE_DURE_FEEDBACK_ENDPOINT` exists to serve) `invoke` rejects. Both
 * dialogs gate Send on this value arriving, so that rejection left Send
 * permanently disabled with nothing on screen explaining why, and went
 * unhandled besides. A report from an unknown machine is a worse report,
 * not a reason to refuse to send one.
 */
export function feedbackEnvironment(): Promise<FeedbackEnvironmentInfo> {
	return invoke<FeedbackEnvironmentInfo>("feedback_environment").catch(() => ({
		os: "unknown",
		arch: "unknown",
	}));
}

const DEFAULT_FEEDBACK_ENDPOINT = "https://dure-feedback.fly.dev/v1/feedback";

function feedbackEndpoint(): string {
	return (
		import.meta.env.VITE_DURE_FEEDBACK_ENDPOINT ?? DEFAULT_FEEDBACK_ENDPOINT
	);
}

/** Distinct, typed submission failures the dialog can branch on — never a
 *  bare thrown string and never collapsed into one generic error.
 *  `"rejected"` covers both HTTP 400 and 413: the intake will never accept
 *  this exact payload, so retrying it unchanged cannot help. */
export type FeedbackSubmitFailureKind =
	| "rejected"
	| "rate_limited"
	| "temporary"
	| "network";

export class FeedbackSubmitError extends Error {
	constructor(
		readonly kind: FeedbackSubmitFailureKind,
		message: string,
		/** Set only for a `"rejected"` 413: the wire field the intake's
		 *  `Submission::parse` (wire.rs) rejected as too large — one of
		 *  `"body"`, `"contact"`, `"attachment count"`, `"attachment name"`,
		 *  `"attachment bytes"`, or `"env.<name>"` for one of the six
		 *  environment values (`env.app`, `env.channel`, `env.os`,
		 *  `env.arch`, `env.locale`, `env.window`). A screenshot can push a
		 *  payload over the 4 MB attachment cap on its own; when `field`
		 *  starts with `"attachment"`, the dialog can offer "remove the
		 *  screenshot and retry" instead of treating the whole report as
		 *  unsendable, and a `"contact"` rejection is fixed by shortening
		 *  the field. The `env.*` values are machine-read and capped well
		 *  above any real value, so the dialog has nothing specific to
		 *  offer there. */
		readonly field?: string,
		/** Minimum delay supplied by the intake for a 429, in whole seconds. */
		readonly retryAfterSeconds?: number,
	) {
		super(message);
		this.name = "FeedbackSubmitError";
	}
}

interface FeedbackAcceptedResponse {
	id?: unknown;
}

interface FeedbackInvalidSubmissionResponse {
	message?: unknown;
}

interface FeedbackPayloadTooLargeResponse {
	field?: unknown;
}

function validRetryDelay(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= 0 &&
		value <= Math.floor(Number.MAX_SAFE_INTEGER / 1000)
	);
}

/**
 * Posts one assembled envelope to the feedback intake
 * (`POST /v1/feedback`, crates/dure-feedback-intake/src/http.rs).
 *
 * Maps the intake's response to a typed outcome instead of throwing bare
 * strings:
 * - 201 resolves with `{ reference }` (the intake's `id` field).
 * - 400 (`INVALID_SUBMISSION`) and 413 (`PAYLOAD_TOO_LARGE`) reject with
 *   `FeedbackSubmitError("rejected", …)` — retrying the same payload cannot
 *   help. A 413 carries the intake's `field` (which wire-contract limit was
 *   exceeded) so the dialog can react specifically, e.g. drop an oversized
 *   screenshot and resubmit rather than discarding the whole report.
 * - 429 (`RATE_LIMITED`) rejects with `FeedbackSubmitError("rate_limited", …)`.
 * - 503 (kill switch or delivery failure) and any other unexpected status
 *   reject with `FeedbackSubmitError("temporary", …)` — the intake, not this
 *   payload, is at fault, and a later retry may succeed.
 * - A `fetch` failure itself rejects with `FeedbackSubmitError("network", …)`.
 */
export async function submitFeedback(
	envelope: FeedbackEnvelope,
): Promise<{ reference: string }> {
	let response: Response;
	try {
		response = await fetch(feedbackEndpoint(), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(envelope),
		});
	} catch (error) {
		throw new FeedbackSubmitError(
			"network",
			`feedback request failed: ${String(error)}`,
		);
	}

	if (response.status === 201) {
		const data = (await response
			.json()
			.catch(() => null)) as FeedbackAcceptedResponse | null;
		if (typeof data?.id === "string" && data.id.length > 0) {
			return { reference: data.id };
		}
		throw new FeedbackSubmitError(
			"temporary",
			"feedback accepted but no reference was returned",
		);
	}
	if (response.status === 400) {
		const data = (await response
			.json()
			.catch(() => null)) as FeedbackInvalidSubmissionResponse | null;
		const detail = typeof data?.message === "string" ? data.message : undefined;
		throw new FeedbackSubmitError(
			"rejected",
			detail ? `feedback rejected: ${detail}` : "feedback rejected (400)",
		);
	}
	if (response.status === 413) {
		const data = (await response
			.json()
			.catch(() => null)) as FeedbackPayloadTooLargeResponse | null;
		const field = typeof data?.field === "string" ? data.field : undefined;
		throw new FeedbackSubmitError(
			"rejected",
			field
				? `feedback rejected: ${field} too large`
				: "feedback rejected (413)",
			field,
		);
	}
	if (response.status === 429) {
		const header = response.headers.get("retry-after");
		const headerSeconds =
			header !== null && /^\d+$/.test(header) ? Number(header) : undefined;
		const data = (await response.json().catch(() => null)) as {
			retryAfterSeconds?: unknown;
		} | null;
		const seconds = validRetryDelay(headerSeconds)
			? headerSeconds
			: data?.retryAfterSeconds;
		throw new FeedbackSubmitError(
			"rate_limited",
			"feedback rate limited",
			undefined,
			validRetryDelay(seconds) ? seconds : undefined,
		);
	}
	throw new FeedbackSubmitError(
		"temporary",
		`feedback temporarily unavailable (${response.status})`,
	);
}
