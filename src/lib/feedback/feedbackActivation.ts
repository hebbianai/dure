// Opening the feedback dialog from somewhere other than its keyboard chord —
// today, the unified search dialog's "Send feedback" command.
//
// The dialog's open state belongs to LazyFeedbackDialog: it owns the lazy
// chunk, and — critically — it owns the capture-before-open sequencing (the
// dialog covers the window, so a screenshot taken after it opens would
// photograph the feedback form instead of the app). Other triggers must not
// get a second way to open it directly; they ask instead. Same
// window-CustomEvent idiom as quickDispatchActivation.ts and
// search/nativeSearchBus.ts: presentation-only signalling, no store, no
// second state authority.
//
// The invariant every caller of `requestFeedback()` must hold: only call it
// once your own surface is already gone (this module cannot enforce that —
// see LazyFeedbackDialog's `onCloseAutoFocus` handling in
// NativeSearchDialog.tsx, which exists solely to satisfy it for the search
// palette), or once you are certain the capture will photograph it on
// purpose. Nothing here checks either condition; a new caller that skips
// this has silently reintroduced the exact wrong-picture bug the
// capture-before-open sequencing exists to prevent. ErrorReportDialog
// (Task 8) does not call this — it is already open and its own Send path
// captures nothing — but is recorded here as the second reader who had to
// learn this the hard way, so a third does not have to.
const ACTIVATION_EVENT = "dure:feedback-activate";

/** Ask the launcher to capture the window and open the feedback dialog. */
export function requestFeedback(): void {
	window.dispatchEvent(new CustomEvent(ACTIVATION_EVENT));
}

export function onFeedbackRequest(callback: () => void): () => void {
	const handler = () => callback();
	window.addEventListener(ACTIVATION_EVENT, handler);
	return () => window.removeEventListener(ACTIVATION_EVENT, handler);
}
