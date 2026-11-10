// Asking for Pinpoint's address dialog from somewhere other than its chord.
// PinpointButton owns the dialog, so other surfaces request it rather than
// mounting a second one. Same window-CustomEvent idiom as
// quickDispatchActivation.ts.

const ACTIVATION_EVENT = "dure:pinpoint-browser-activate";

export function requestPinpointBrowser(): void {
	window.dispatchEvent(new CustomEvent(ACTIVATION_EVENT));
}

export function onPinpointBrowserRequest(callback: () => void): () => void {
	window.addEventListener(ACTIVATION_EVENT, callback);
	return () => window.removeEventListener(ACTIVATION_EVENT, callback);
}
