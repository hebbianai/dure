import {
	type CurrentWindowLiveResizePhase,
	subscribeCurrentWindowLiveResize,
} from "@/lib/workspace/window/currentWindowResize";
import {
	beginTerminalDocumentResize,
	finishTerminalDocumentResize,
} from "./terminalDocumentResizeTransaction";

export type TerminalNativeWindowResizeSubscriber = (
	listener: (phase: CurrentWindowLiveResizePhase) => void,
) => Promise<() => void>;

/** Maps one native live-resize gesture onto one document resize transaction. */
export function bindTerminalNativeWindowResize(
	doc: Document,
	surfaceKey: string,
	subscribe: TerminalNativeWindowResizeSubscriber = subscribeCurrentWindowLiveResize,
): () => void {
	let disposed = false;
	let generation: number | undefined;
	let unsubscribe: (() => void) | undefined;

	const finish = () => {
		if (generation === undefined) return;
		const activeGeneration = generation;
		generation = undefined;
		finishTerminalDocumentResize(doc, "native_window", activeGeneration);
	};
	const onPhase = (phase: CurrentWindowLiveResizePhase) => {
		if (disposed) return;
		if (phase === "begin") {
			generation ??= beginTerminalDocumentResize(doc, surfaceKey);
			return;
		}
		finish();
	};

	void subscribe(onPhase)
		.then((stop) => {
			if (disposed) stop();
			else unsubscribe = stop;
		})
		.catch(() => {
			if (!disposed) finish();
		});

	return () => {
		if (disposed) return;
		disposed = true;
		unsubscribe?.();
		finish();
	};
}
