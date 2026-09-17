export interface CurrentWindowFocusBackend {
	listen(listener: (focused: boolean) => void): Promise<() => void>;
	read(): Promise<boolean>;
}

/** Shares one retained native focus source across every client in a WebView. */
export class CurrentWindowFocusAuthority {
	private readonly listeners = new Set<(focused: boolean) => void>();
	private readonly inputReadyListeners = new Set<(ready: boolean) => void>();
	private focused: boolean;
	private domFocused: boolean;
	private nativeRevision = 0;
	private started = false;

	constructor(
		initialFocused: boolean,
		private readonly backend: CurrentWindowFocusBackend,
	) {
		this.focused = initialFocused;
		this.domFocused = initialFocused;
	}

	current(): boolean {
		return this.focused;
	}

	subscribe(listener: (focused: boolean) => void): () => void {
		this.listeners.add(listener);
		listener(this.focused);
		this.start();
		return () => this.listeners.delete(listener);
	}

	/**
	 * Native key-window focus and WebView DOM readiness can arrive on separate
	 * event-loop turns. Input is ready only after both signals agree.
	 */
	subscribeInputReady(listener: (ready: boolean) => void): () => void {
		this.inputReadyListeners.add(listener);
		listener(this.inputReady());
		this.start();
		return () => this.inputReadyListeners.delete(listener);
	}

	/**
	 * DOM focus remains a browser/dev fallback for native ownership, but always
	 * advances WebView input readiness after native focus becomes authoritative.
	 */
	updateFallback(focused: boolean): void {
		const previousInputReady = this.inputReady();
		this.domFocused = focused;
		if (this.nativeRevision === 0) this.publish(focused);
		this.publishInputReady(previousInputReady);
	}

	private start(): void {
		if (this.started) return;
		this.started = true;
		const installation = this.backend.listen((focused) =>
			this.publishNative(focused),
		);
		void installation
			.then(() => {
				// Tauri owns native cleanup when this WebView realm is destroyed.
				const readRevision = this.nativeRevision;
				void this.backend
					.read()
					.then((focused) => {
						if (readRevision !== this.nativeRevision) return;
						this.publishNative(focused);
					})
					.catch(() => {});
			})
			.catch(() => {
				this.started = false;
			});
	}

	private publishNative(focused: boolean): void {
		const previousInputReady = this.inputReady();
		this.nativeRevision += 1;
		this.publish(focused);
		this.publishInputReady(previousInputReady);
	}

	private publish(focused: boolean): void {
		if (this.focused === focused) return;
		this.focused = focused;
		for (const listener of this.listeners) listener(focused);
	}

	inputReady(): boolean {
		return this.focused && this.domFocused;
	}

	private publishInputReady(previous: boolean): void {
		const next = this.inputReady();
		if (next === previous) return;
		for (const listener of this.inputReadyListeners) listener(next);
	}
}

const CURRENT_WINDOW_FOCUS_AUTHORITY_KEY =
	"__dureCurrentWindowFocusAuthorityV1";

type CurrentWindowFocusGlobal = typeof globalThis & {
	[CURRENT_WINDOW_FOCUS_AUTHORITY_KEY]?: CurrentWindowFocusAuthority;
};

function authority(): CurrentWindowFocusAuthority {
	const owner = globalThis as CurrentWindowFocusGlobal;
	if (owner[CURRENT_WINDOW_FOCUS_AUTHORITY_KEY]) {
		return owner[CURRENT_WINDOW_FOCUS_AUTHORITY_KEY];
	}
	const sharedAuthority = new CurrentWindowFocusAuthority(document.hasFocus(), {
		listen: async (listener) => {
			const { getCurrentWindow } = await import("@tauri-apps/api/window");
			return getCurrentWindow().onFocusChanged(({ payload }) =>
				listener(payload),
			);
		},
		read: async () => {
			const { getCurrentWindow } = await import("@tauri-apps/api/window");
			return getCurrentWindow().isFocused();
		},
	});
	owner[CURRENT_WINDOW_FOCUS_AUTHORITY_KEY] = sharedAuthority;
	window.addEventListener("focus", () => sharedAuthority.updateFallback(true));
	window.addEventListener("blur", () => sharedAuthority.updateFallback(false));
	return sharedAuthority;
}

export function currentWindowIsFocused(): boolean {
	return authority().current();
}

export function subscribeCurrentWindowFocus(
	listener: (focused: boolean) => void,
): () => void {
	return authority().subscribe(listener);
}

export function subscribeCurrentWindowInputReady(
	listener: (ready: boolean) => void,
): () => void {
	return authority().subscribeInputReady(listener);
}

export function currentWindowIsInputReady(): boolean {
	return authority().inputReady();
}
