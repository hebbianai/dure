interface WebviewKeyboardFocusTarget {
	setFocus(): Promise<void>;
}

export interface WebviewKeyboardFocusRecoveryBackend {
	hasDomFocus(): boolean;
	loadTarget(): Promise<WebviewKeyboardFocusTarget>;
	subscribeNativeFocus(
		listener: (focused: boolean) => void,
	): Promise<() => void>;
}

const RETRY_INTERVAL_MS = 250;
const RETRY_DEADLINE_MS = 5_000;

/**
 * Repairs the narrow case where a key native window has no focused WebView.
 *
 * DOM focus is the more specific authority: a button click, editor, or xterm
 * textarea must never be replaced by a late whole-WebView focus request. One
 * recovery may be in flight at a time, and it rechecks that authority after
 * the lazy Tauri target load so an accepted first click always wins the race.
 */
export class WebviewKeyboardFocusRecovery {
	private started = false;
	private disposed = false;
	private pending: Promise<void> | undefined;
	private retryTimer: ReturnType<typeof setInterval> | undefined;
	private retryDeadline: ReturnType<typeof setTimeout> | undefined;
	private stopNative: (() => void) | undefined;

	constructor(private readonly backend: WebviewKeyboardFocusRecoveryBackend) {}

	start(): void {
		if (this.disposed || this.started) return;
		this.started = true;
		void this.recover();
		this.retryTimer = setInterval(() => {
			if (this.disposed || this.backend.hasDomFocus()) {
				this.stopRetry();
				return;
			}
			void this.recover();
		}, RETRY_INTERVAL_MS);
		this.retryDeadline = setTimeout(() => this.stopRetry(), RETRY_DEADLINE_MS);
		void this.backend
			.subscribeNativeFocus((focused) => {
				if (focused) void this.recover();
			})
			.then((stop) => {
				if (this.disposed) stop();
				else this.stopNative = stop;
			})
			.catch(() => {});
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.stopRetry();
		this.stopNative?.();
		this.stopNative = undefined;
	}

	private recover(): Promise<void> {
		if (this.disposed || this.backend.hasDomFocus()) return Promise.resolve();
		if (this.pending) return this.pending;
		const operation = this.backend
			.loadTarget()
			.then(async (target) => {
				if (this.disposed || this.backend.hasDomFocus()) return;
				await target.setFocus();
			})
			.catch(() => {});
		const tracked = operation.finally(() => {
			if (this.pending === tracked) this.pending = undefined;
		});
		this.pending = tracked;
		return tracked;
	}

	private stopRetry(): void {
		if (this.retryTimer !== undefined) clearInterval(this.retryTimer);
		if (this.retryDeadline !== undefined) clearTimeout(this.retryDeadline);
		this.retryTimer = undefined;
		this.retryDeadline = undefined;
	}
}
