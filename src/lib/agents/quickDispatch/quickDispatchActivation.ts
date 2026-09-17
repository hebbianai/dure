// Opening the quick-dispatch compose surface from somewhere other than its
// keyboard chord.
//
// The overlay's open state belongs to LazyQuickDispatchOverlay — it owns the
// lazy chunk and unmounts on close so every reopen starts clean. Menus must
// not get a second way to mount it, so they ask instead: this is a request
// bus, and the launcher stays the only component that decides it is open.
//
// Same window-CustomEvent idiom as quickDispatchProgress.ts (and
// search/nativeSearchBus.ts): presentation-only signalling, no store, no
// second authority.

const ACTIVATION_EVENT = "dure:quick-dispatch-activate";

export interface QuickDispatchPrefill {
	projectId: string;
	promptText: string;
	typedName: string;
}

/** Ask the launcher to open the compose surface — what ⌘N does. */
export function requestQuickDispatch(prefill?: QuickDispatchPrefill): void {
	window.dispatchEvent(
		new CustomEvent<QuickDispatchPrefill | undefined>(ACTIVATION_EVENT, {
			detail: prefill,
		}),
	);
}

export function onQuickDispatchRequest(
	callback: (prefill?: QuickDispatchPrefill) => void,
): () => void {
	const handler = (event: Event) =>
		callback((event as CustomEvent<QuickDispatchPrefill | undefined>).detail);
	window.addEventListener(ACTIVATION_EVENT, handler);
	return () => window.removeEventListener(ACTIVATION_EVENT, handler);
}
