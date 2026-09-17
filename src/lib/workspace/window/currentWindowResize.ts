import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { observeCurrentWindowLiveResize } from "@/lib/ipc/system";

const CURRENT_WINDOW_LIVE_RESIZE_EVENT = "dure://window-live-resize";

export type CurrentWindowLiveResizePhase = "begin" | "end";

interface CurrentWindowResizeBackend {
	listen(listener: () => void): Promise<UnlistenFn>;
}

/** Owns the current window's resize source for the whole WebView realm. */
class CurrentWindowResizeAuthority {
	private readonly listeners = new Set<() => void>();
	private started = false;

	constructor(private readonly backend: CurrentWindowResizeBackend) {}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		this.start();
		return () => this.listeners.delete(listener);
	}

	private start(): void {
		if (this.started) return;
		this.started = true;
		const installation = this.backend.listen(() => {
			for (const listener of [...this.listeners]) listener();
		});
		// Tauri owns native cleanup when this WebView realm is destroyed.
		void installation.catch(() => {
			this.started = false;
		});
	}
}

const CURRENT_WINDOW_RESIZE_AUTHORITY_KEY =
	"__dureCurrentWindowResizeAuthorityV1";

type CurrentWindowResizeGlobal = typeof globalThis & {
	[CURRENT_WINDOW_RESIZE_AUTHORITY_KEY]?: CurrentWindowResizeAuthority;
};

function authority(): CurrentWindowResizeAuthority {
	const owner = globalThis as CurrentWindowResizeGlobal;
	owner[CURRENT_WINDOW_RESIZE_AUTHORITY_KEY] ??=
		new CurrentWindowResizeAuthority({
			listen: (listener) => getCurrentWindow().onResized(listener),
		});
	return owner[CURRENT_WINDOW_RESIZE_AUTHORITY_KEY];
}

export function subscribeCurrentWindowResize(listener: () => void): () => void {
	return authority().subscribe(listener);
}

/** Subscribes to AppKit's exact mouse-driven live-resize boundaries. */
export async function subscribeCurrentWindowLiveResize(
	listener: (phase: CurrentWindowLiveResizePhase) => void,
): Promise<UnlistenFn> {
	const window = getCurrentWebviewWindow();
	let boundaryObserved = false;
	const unlisten = await window.listen<unknown>(
		CURRENT_WINDOW_LIVE_RESIZE_EVENT,
		(event) => {
			if (event.payload === "begin" || event.payload === "end") {
				boundaryObserved = true;
				listener(event.payload);
			}
		},
	);
	try {
		const alreadyLive = await observeCurrentWindowLiveResize();
		if (alreadyLive && !boundaryObserved) listener("begin");
		return unlisten;
	} catch (error) {
		unlisten();
		throw error;
	}
}
