import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { ClipboardCopy, Send } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { FormField } from "@/components/common/FormField";
import { KeyValueList, KeyValueRow } from "@/components/common/KeyValueList";
import { useFeedbackLocale } from "@/components/feedback/useFeedbackLocale";
import { Alert } from "@/components/ui/alert";
import { ConfirmationButton } from "@/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Disclosure } from "@/components/ui/disclosure";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { getOrCreateFeedbackDeviceId } from "@/lib/feedback/deviceId";
import {
	buildEnvelope,
	FEEDBACK_BODY_LIMIT,
	FEEDBACK_CONTACT_LIMIT,
	type FeedbackEnvelope,
	type FeedbackKind,
} from "@/lib/feedback/envelope";
import {
	readRememberedFeedbackContact,
	rememberFeedbackContact,
} from "@/lib/feedback/feedbackContact";
import { feedbackEnvelopeInput } from "@/lib/feedback/feedbackEnvelopeInput";
import { renderFeedbackPreview } from "@/lib/feedback/feedbackPreview";
import { t } from "@/lib/i18n";
import {
	type CapturedPng,
	FeedbackSubmitError,
	feedbackEnvironment,
	submitFeedback,
} from "@/lib/ipc/feedback";
import { errorMessage } from "@/lib/payloadGuards";
import { configuredFrontendAppChannel } from "@/lib/platform/appChannel";
import { frontendRuntimeObservation } from "@/lib/platform/frontendRuntimeObservation";

/** The screen capture the launcher attempted before opening this dialog —
 *  see LazyFeedbackDialog.tsx. A rejection carries the ipc wrapper's raw
 *  reason string (for example "screen_recording_permission") so this
 *  component can react to the exact code without re-deriving it. */
export type FeedbackCaptureResult =
	| { readonly ok: true; readonly screenshot: CapturedPng }
	| { readonly ok: false; readonly reason: string };

/** feedback_capture.rs's stable rejection code for a denied macOS Screen
 *  Recording permission — the one capture failure with dedicated guidance
 *  rather than a generic message. */
const SCREEN_RECORDING_PERMISSION_REASON = "screen_recording_permission";

/** The three kinds a person picks from. `FeedbackEnvelope`'s "crash" kind is
 *  reserved for ErrorReportDialog's own future submit path (Task 8). */
type UiFeedbackKind = Exclude<FeedbackKind, "crash">;

type SendStatus =
	| { kind: "idle" }
	| { kind: "sending" }
	| { kind: "sent"; reference: string }
	| { kind: "failed"; error: FeedbackSubmitError; retryAtMs?: number };

type CopyStatus = { kind: "success" | "error"; message: string };

export interface FeedbackDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	capture: FeedbackCaptureResult;
}

export function FeedbackDialog({
	open,
	onOpenChange,
	capture,
}: FeedbackDialogProps) {
	const [kind, setKind] = useState<UiFeedbackKind>("bug");
	const [body, setBody] = useState("");
	const [contact, setContact] = useState(() => readRememberedFeedbackContact());
	const [includeScreenshot, setIncludeScreenshot] = useState(capture.ok);
	const [status, setStatus] = useState<SendStatus>({ kind: "idle" });
	const [now, setNow] = useState(Date.now);
	const [copyStatus, setCopyStatus] = useState<CopyStatus | null>(null);
	// A 64px object-cover thumbnail is not a review surface. The notice can
	// only honestly say "this is what gets sent" if the capture can actually
	// be looked at, so the thumbnail opens it at natural size.
	const [screenshotExpanded, setScreenshotExpanded] = useState(false);
	// null until feedbackEnvironment() resolves. Sending before then would
	// post os:"" / arch:"" — the two most useful triage fields — silently
	// losing them on exactly the fast submissions a keyboard entry point
	// produces (review finding), so Send stays disabled until this is set.
	const [environment, setEnvironment] = useState<{
		os: string;
		arch: string;
	} | null>(null);

	// feedbackEnvironment() never rejects: ipc/feedback.ts resolves
	// { os: "unknown", arch: "unknown" } outside a Tauri webview rather than
	// leaving Send disabled forever on an unhandled rejection.
	useEffect(() => {
		let cancelled = false;
		void feedbackEnvironment().then((info) => {
			if (!cancelled) setEnvironment(info);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	const locale = useFeedbackLocale();
	const deviceId = useMemo(() => getOrCreateFeedbackDeviceId(), []);
	// Captured once per dialog open, not re-read on every render: the preview
	// and the later submit must describe the same window, and re-measuring on
	// each keystroke would let a mid-draft resize silently change what "the
	// window" means between the two.
	const windowSize = useMemo(
		() => ({ width: window.innerWidth, height: window.innerHeight }),
		[],
	);
	const app = frontendRuntimeObservation.buildId;
	const channel = configuredFrontendAppChannel() ?? "unset";

	// buildEnvelope is pure and total, so the exact same call — same
	// arguments in, same object out — used for the visible preview is also
	// what gets posted. `app`/`channel` are passed explicitly (not left to
	// buildEnvelope's own fallback) so nothing this component depends on a
	// second, unstated source of truth. feedbackEnvelopeInput is the one
	// place that turns this draft state into buildEnvelope's input — the
	// "send without screenshot" retry below calls it too, so the two paths
	// can never disagree about what EnvelopeInput looks like.
	const envelope = useMemo<FeedbackEnvelope>(
		() =>
			buildEnvelope(
				feedbackEnvelopeInput({
					kind,
					body,
					contact,
					deviceId,
					locale,
					window: windowSize,
					os: environment?.os ?? "",
					arch: environment?.arch ?? "",
					capture,
					includeScreenshot,
					app,
					channel,
				}),
			),
		[
			kind,
			body,
			contact,
			deviceId,
			locale,
			windowSize,
			environment,
			capture,
			includeScreenshot,
			app,
			channel,
		],
	);
	// The rendered preview elides the attachment's base64 bytes (0.3-1.4 MB,
	// re-serialized and re-flowed on every keystroke otherwise) behind a
	// labelled marker — the thumbnail above already shows the image. Submit
	// always posts `envelope` itself, never this string.
	const preview = useMemo(() => renderFeedbackPreview(envelope), [envelope]);

	const sending = status.kind === "sending";
	const retryAtMs = status.kind === "failed" ? status.retryAtMs : undefined;
	const retrySeconds =
		retryAtMs === undefined
			? 0
			: Math.max(0, Math.ceil((retryAtMs - now) / 1000));
	const waitingToRetry = retrySeconds > 0;
	useEffect(() => {
		if (!open || !waitingToRetry) return;
		// Recompute from the deadline so sleep and throttled WebViews do not
		// extend the server's delay by counting only delivered timer ticks.
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [open, waitingToRetry]);
	const isPermissionFailure =
		!capture.ok && capture.reason === SCREEN_RECORDING_PERMISSION_REASON;

	async function send(envelopeToSend: FeedbackEnvelope) {
		if (sending || waitingToRetry) return;
		setStatus({ kind: "sending" });
		try {
			const result = await submitFeedback(envelopeToSend);
			rememberFeedbackContact(contact);
			setStatus({ kind: "sent", reference: result.reference });
		} catch (error) {
			const failure =
				error instanceof FeedbackSubmitError
					? error
					: new FeedbackSubmitError("network", errorMessage(error));
			const receivedAt = Date.now();
			setNow(receivedAt);
			setStatus({
				kind: "failed",
				error: failure,
				retryAtMs:
					failure.kind === "rate_limited" &&
					failure.retryAfterSeconds !== undefined
						? receivedAt + failure.retryAfterSeconds * 1000
						: undefined,
			});
		}
	}

	const sendWithoutScreenshot = () => {
		setIncludeScreenshot(false);
		void send(
			buildEnvelope(
				feedbackEnvelopeInput({
					kind,
					body,
					contact,
					deviceId,
					locale,
					window: windowSize,
					os: environment?.os ?? "",
					arch: environment?.arch ?? "",
					capture,
					includeScreenshot: false,
					app,
					channel,
				}),
			),
		);
	};

	// Any edit makes the next Send a different payload from the one that
	// failed or succeeded, so the previous outcome no longer describes what
	// Send would do. Without this, a 413 naming `contact` — the one
	// rejection the user can actually fix — left the verdict standing even
	// after they shortened it. `sending` is left alone: that request is
	// still in flight and owns the status until it settles. Rate limits apply
	// to the sender, so editing the draft must not clear their retry deadline.
	const clearSendOutcome = () => {
		setStatus((current) =>
			current.kind === "idle" ||
			current.kind === "sending" ||
			(current.kind === "failed" && current.error.kind === "rate_limited")
				? current
				: { kind: "idle" },
		);
	};

	const copyReport = async () => {
		try {
			await writeText(preview);
			setCopyStatus({
				kind: "success",
				message: t("feedback.dialog.copySuccess"),
			});
		} catch (error) {
			setCopyStatus({
				kind: "error",
				message: t("feedback.dialog.copyFailed", {
					error: errorMessage(error),
				}),
			});
		}
	};

	const kindOptions: { value: UiFeedbackKind; label: string }[] = [
		{ value: "bug", label: t("feedback.dialog.kind.bug") },
		{ value: "idea", label: t("feedback.dialog.kind.idea") },
		{ value: "other", label: t("feedback.dialog.kind.other") },
	];

	const attachmentTooLarge =
		status.kind === "failed" &&
		status.error.kind === "rejected" &&
		status.error.field?.startsWith("attachment") === true;
	// A 413 naming `contact` is the user's to fix — shorten it and send
	// again — so it is a rejection of this payload, not of this report.
	const contactTooLong =
		status.kind === "failed" &&
		status.error.kind === "rejected" &&
		status.error.field === "contact";
	// The intake documents 400/413 as unretryable: it will never accept this
	// exact payload. Two exceptions are payloads the user can change — the
	// attachment case has its own button, and an over-long contact is fixed
	// by editing the field. Everything else must not be offered a Retry that
	// re-posts byte for byte and spends one of the device's five hourly
	// submissions on a request already known to fail.
	const unretryable =
		status.kind === "failed" &&
		status.error.kind === "rejected" &&
		!attachmentTooLarge &&
		!contactTooLong;
	const sent = status.kind === "sent";

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[min(48rem,calc(100vh-2rem))] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-3xl">
				<DialogHeader>
					<DialogTitle>{t("feedback.dialog.title")}</DialogTitle>
					<DialogDescription>
						{t("feedback.dialog.description")}
					</DialogDescription>
				</DialogHeader>

				<div className="min-h-0 space-y-3 overflow-y-auto pr-1">
					<FormField label={t("feedback.dialog.kindLabel")}>
						<Segmented
							value={kind}
							onChange={(next) => {
								setKind(next);
								clearSendOutcome();
							}}
							options={kindOptions}
						/>
					</FormField>

					<FormField label={t("feedback.dialog.bodyLabel")}>
						<Textarea
							autoFocus
							className="min-h-24 text-xs"
							maxLength={FEEDBACK_BODY_LIMIT}
							placeholder={t("feedback.dialog.bodyPlaceholder")}
							value={body}
							onChange={(event) => {
								setBody(event.target.value);
								clearSendOutcome();
							}}
						/>
					</FormField>

					{capture.ok ? (
						<div className="space-y-2 rounded-md border border-border/70 p-2">
							<div className="flex items-center gap-3">
								<button
									type="button"
									aria-label={
										screenshotExpanded
											? t("feedback.dialog.screenshot.collapse")
											: t("feedback.dialog.screenshot.expand")
									}
									className="shrink-0 rounded border border-border/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
									onClick={() => setScreenshotExpanded((shown) => !shown)}
								>
									<img
										src={`data:image/png;base64,${capture.screenshot.pngB64}`}
										alt=""
										className="h-16 w-auto rounded object-cover"
									/>
								</button>
								<span className="min-w-0 flex-1 text-xs text-muted-foreground">
									{includeScreenshot
										? t("feedback.dialog.screenshot.included")
										: t("feedback.dialog.screenshot.removed")}
								</span>
								<Switch
									checked={includeScreenshot}
									aria-label={t("feedback.dialog.screenshot.title")}
									onCheckedChange={setIncludeScreenshot}
								/>
							</div>
							{screenshotExpanded && (
								<div className="max-h-96 overflow-auto rounded border border-border/60 bg-background">
									<img
										src={`data:image/png;base64,${capture.screenshot.pngB64}`}
										alt={t("feedback.dialog.screenshot.fullAlt")}
										width={capture.screenshot.width}
										height={capture.screenshot.height}
										className="max-w-none"
									/>
								</div>
							)}
						</div>
					) : isPermissionFailure ? (
						<Alert
							tone="warn"
							title={t("feedback.dialog.screenshot.permissionTitle")}
						>
							{t("feedback.dialog.screenshot.permissionBody")}
						</Alert>
					) : (
						<Alert tone="neutral">
							{t("feedback.dialog.screenshot.captureFailed", {
								reason: capture.reason,
							})}
						</Alert>
					)}

					<FormField label={t("feedback.dialog.contactLabel")}>
						<Input
							type="text"
							maxLength={FEEDBACK_CONTACT_LIMIT}
							placeholder={t("feedback.dialog.contactPlaceholder")}
							value={contact}
							onChange={(event) => {
								setContact(event.target.value);
								clearSendOutcome();
							}}
						/>
					</FormField>

					<Disclosure label={t("feedback.dialog.environment.summary")}>
						<KeyValueList labelWidth="6rem">
							<KeyValueRow label={t("feedback.dialog.environment.os")} mono>
								{envelope.env.os}
							</KeyValueRow>
							<KeyValueRow label={t("feedback.dialog.environment.arch")} mono>
								{envelope.env.arch}
							</KeyValueRow>
							<KeyValueRow label={t("feedback.dialog.environment.locale")} mono>
								{envelope.env.locale}
							</KeyValueRow>
							<KeyValueRow label={t("feedback.dialog.environment.window")} mono>
								{envelope.env.window}
							</KeyValueRow>
							<KeyValueRow label={t("feedback.dialog.environment.app")} mono>
								{envelope.env.app}
							</KeyValueRow>
							<KeyValueRow
								label={t("feedback.dialog.environment.channel")}
								mono
							>
								{envelope.env.channel}
							</KeyValueRow>
						</KeyValueList>
					</Disclosure>

					<div className="rounded-md border border-border/70 bg-muted/30 p-2 text-[11px] leading-relaxed text-muted-foreground">
						<p className="font-medium text-foreground">
							{t("feedback.dialog.notice.title")}
						</p>
						{/* One sentence cannot describe both states: on a
						    permission denial, an unsupported platform or a
						    capture timeout an Alert stands where the thumbnail
						    would be, and nothing on screen is going anywhere. */}
						<p>
							{capture.ok && includeScreenshot
								? t("feedback.dialog.notice.withScreenshot")
								: t("feedback.dialog.notice.withoutScreenshot")}
						</p>
					</div>

					<pre
						data-testid="feedback-preview"
						aria-label={t("feedback.dialog.previewLabel")}
						className="max-h-64 overflow-auto rounded-md border bg-background p-3 font-mono text-[11px] whitespace-pre-wrap break-all"
					>
						{preview}
					</pre>

					{copyStatus && (
						<p
							className={
								copyStatus.kind === "error"
									? "text-xs text-destructive"
									: "text-xs text-status-run"
							}
							role="status"
						>
							{copyStatus.message}
						</p>
					)}

					{status.kind === "sent" && (
						<p className="text-xs text-status-run" role="status">
							{t("feedback.dialog.sentNotice", { reference: status.reference })}
						</p>
					)}

					{status.kind === "failed" && (
						<Alert tone="destructive">
							{status.error.kind === "rejected"
								? attachmentTooLarge
									? t("feedback.dialog.error.attachmentTooLarge")
									: t("feedback.dialog.error.rejected", {
											message: status.error.message,
										})
								: status.error.kind === "rate_limited"
									? waitingToRetry
										? t("feedback.dialog.error.rateLimitedWait", {
												seconds: retrySeconds,
											})
										: retryAtMs !== undefined
											? t("feedback.dialog.error.rateLimitedReady")
											: t("feedback.dialog.error.rateLimited")
									: status.error.kind === "temporary"
										? t("feedback.dialog.error.temporary")
										: t("feedback.dialog.error.network")}
							{attachmentTooLarge && (
								<ConfirmationButton
									variant="glass"
									className="mt-2"
									onClick={sendWithoutScreenshot}
								>
									{t("feedback.dialog.sendWithoutScreenshot")}
								</ConfirmationButton>
							)}
						</Alert>
					)}
				</div>

				<DialogFooter>
					<DialogClose asChild>
						<ConfirmationButton variant="glass" disabled={sending}>
							{t("common.close")}
						</ConfirmationButton>
					</DialogClose>
					<ConfirmationButton
						variant="glass"
						disabled={sending}
						onClick={() => void copyReport()}
					>
						<ClipboardCopy className="size-3.5" />
						{t("feedback.dialog.copyReport")}
					</ConfirmationButton>
					<ConfirmationButton
						disabled={
							sending ||
							waitingToRetry ||
							sent ||
							unretryable ||
							body.trim().length === 0 ||
							environment === null
						}
						onClick={() => void send(envelope)}
					>
						<Send className="size-3.5" />
						{sent
							? t("feedback.dialog.sent")
							: sending
								? t("feedback.dialog.sending")
								: status.kind === "failed" && !unretryable
									? t("feedback.dialog.retry")
									: t("feedback.dialog.send")}
					</ConfirmationButton>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
