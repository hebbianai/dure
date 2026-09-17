import {
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { readShortcutOverrides } from "@/components/agents/quickDispatch/useQuickDispatch";
import type { FeedbackCaptureResult } from "@/components/feedback/FeedbackDialog";
import { onFeedbackRequest } from "@/lib/feedback/feedbackActivation";
import { t } from "@/lib/i18n";
import { feedbackCaptureMainWindow } from "@/lib/ipc/feedback";
import { errorMessage } from "@/lib/payloadGuards";
import { matchesChord, shortcutChord } from "@/lib/settings/shortcutBindings";
import { shouldYieldToTerminal } from "@/lib/settings/shortcutPriority";

/** How long the launcher waits for `feedback_capture_main_window` before
 *  opening the dialog without a screenshot.
 *
 *  Not a retry or a smoothing timer over a flaky call: it is the bound on a
 *  single OS call that has no bound of its own. `busyRef` below is released
 *  only when the dialog closes, and the dialog only opens once the capture
 *  settles — so a capture that never settles took out both entry points for
 *  the rest of the session, silently. The user pressed a key; they get the
 *  dialog, screenshot or not. */
const CAPTURE_DEADLINE_MS = 10_000;

/** The capture's own rejection code when it ran past `CAPTURE_DEADLINE_MS`.
 *  Shaped like feedback_capture.rs's other codes so the dialog's existing
 *  generic branch reports it the same way. */
const CAPTURE_TIMEOUT_REASON = "capture_timed_out";

const FeedbackDialog = lazy(() =>
	import("@/components/feedback/FeedbackDialog").then((module) => ({
		default: module.FeedbackDialog,
	})),
);

interface FeedbackActivation {
	revision: number;
	capture: FeedbackCaptureResult;
}

/** Keep the feedback dialog's form, preview and submit code out of cold
 * startup, mirroring LazyQuickDispatchOverlay/LazyNativeSearchDialog. This
 * tiny launcher owns every activation path — the ⌘⇧/ chord and the search
 * dialog's "Send feedback" command — so it can await the window capture
 * BEFORE the dialog chunk ever mounts. The dialog covers the whole window;
 * capturing after it opens would photograph the feedback form itself
 * instead of the app underneath it. Nothing renders here until the capture
 * (success or failure) has already resolved. */
export function LazyFeedbackDialog() {
	const revision = useRef(0);
	const [activation, setActivation] = useState<FeedbackActivation>();
	// True from the moment a capture starts until the dialog closes — guards
	// against a second ⌘⇧/ press re-capturing (photographing the open
	// feedback form) or bumping `revision` and remounting the dialog, which
	// would discard whatever the user had already typed (review finding).
	const busyRef = useRef(false);

	const activate = useCallback(async () => {
		if (busyRef.current) return;
		busyRef.current = true;
		revision.current += 1;
		const thisRevision = revision.current;
		let deadline: ReturnType<typeof setTimeout> | undefined;
		let capture: FeedbackCaptureResult;
		try {
			const screenshot = await Promise.race([
				feedbackCaptureMainWindow(),
				new Promise<never>((_resolve, reject) => {
					deadline = setTimeout(
						() => reject(new Error(CAPTURE_TIMEOUT_REASON)),
						CAPTURE_DEADLINE_MS,
					);
				}),
			]);
			capture = { ok: true, screenshot };
		} catch (error) {
			capture = { ok: false, reason: errorMessage(error) };
		} finally {
			clearTimeout(deadline);
		}
		setActivation({ revision: thisRevision, capture });
	}, []);

	// requestFeedback() itself is only dispatched once its caller's own UI is
	// already gone (NativeSearchDialog fires it from Radix's
	// onCloseAutoFocus, its real close-completion signal — see that file),
	// so this listener needs no delay of its own: by the time the bus event
	// arrives, whatever was on screen before is already off it.
	useEffect(() => onFeedbackRequest(() => void activate()), [activate]);
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			const chord = shortcutChord("send-feedback", readShortcutOverrides());
			if (!matchesChord(chord, event) || shouldYieldToTerminal()) return;
			event.preventDefault();
			void activate();
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, [activate]);

	const close = useCallback(() => {
		busyRef.current = false;
		setActivation(undefined);
	}, []);

	if (!activation) return null;
	return (
		<Suspense
			fallback={
				<div
					role="status"
					className="fixed inset-0 z-50 flex items-start justify-center pt-[18vh] text-xs text-muted-foreground"
				>
					{t("common.loading")}
				</div>
			}
		>
			<FeedbackDialog
				key={activation.revision}
				open
				onOpenChange={(open) => {
					if (!open) close();
				}}
				capture={activation.capture}
			/>
		</Suspense>
	);
}
