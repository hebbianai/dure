import { useSyncExternalStore } from "react";

function subscribe(listener: () => void): () => void {
	document.addEventListener("visibilitychange", listener);
	return () => document.removeEventListener("visibilitychange", listener);
}

const documentVisible = () => document.visibilityState === "visible";
const serverDocumentVisible = () => true;

/** Whether this window's document is on screen: false while the window is
 * hidden or minimized, so work that only serves what is shown can wait. */
export function useDocumentVisible(): boolean {
	return useSyncExternalStore(
		subscribe,
		documentVisible,
		serverDocumentVisible,
	);
}
