export interface RevealableSecondaryWindow {
	show(): Promise<void>;
	unminimize(): Promise<void>;
	setFocus(): Promise<void>;
}

export interface CreatedSecondaryWindow extends RevealableSecondaryWindow {
	once<T>(
		event: string,
		handler: (event: { payload: T }) => void,
	): Promise<() => void>;
}

export const SECONDARY_WINDOW_EVENT_TIMEOUT_MS = 1_000;
export const SECONDARY_WINDOW_LOOKUP_TIMEOUT_MS = 1_000;
export const SECONDARY_WINDOW_REVEAL_TIMEOUT_MS = 1_500;
export const SECONDARY_WINDOW_CLOSE_TIMEOUT_MS = 1_500;

export class SecondaryWindowOperationTimeout extends Error {
	constructor(operation: string) {
		super(`${operation} timed out`);
		this.name = "SecondaryWindowOperationTimeout";
	}
}

export function withSecondaryWindowTimeout<T>(
	operation: string,
	promise: Promise<T>,
	timeoutMs: number,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new SecondaryWindowOperationTimeout(operation)),
			timeoutMs,
		);
		void promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

/** Bounds a stable-label lookup before callers decide whether to create. */
export function lookupSecondaryWindow<T>(
	find: () => Promise<T | null>,
	timeoutMs = SECONDARY_WINDOW_LOOKUP_TIMEOUT_MS,
): Promise<T | null> {
	return withSecondaryWindowTimeout(
		"secondary window lookup",
		find(),
		timeoutMs,
	);
}

async function pollForWindow<T>(
	find: () => Promise<T | null>,
	timeoutMs: number,
): Promise<T | null> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const remainingMs = Math.max(1, deadline - Date.now());
		const found = await lookupSecondaryWindow(find, remainingMs);
		if (found) return found;
		const delayMs = Math.min(50, Math.max(0, deadline - Date.now()));
		if (delayMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}
	return null;
}

/** Waits for creation, then recovers a missed Tauri event by stable label. */
export async function waitForSecondaryWindowCreation<T extends CreatedSecondaryWindow>(
	window: T,
	find: () => Promise<T | null>,
): Promise<T> {
	let settle: (() => void) | undefined;
	let fail: ((error: unknown) => void) | undefined;
	const created = new Promise<void>((resolve, reject) => {
		settle = resolve;
		fail = reject;
	});
	const createdUnlisten = window.once("tauri://created", () => settle?.());
	const errorUnlisten = window.once<unknown>("tauri://error", (event) =>
		fail?.(event.payload),
	);
	try {
		await withSecondaryWindowTimeout(
			"secondary window creation",
			created,
			SECONDARY_WINDOW_EVENT_TIMEOUT_MS,
		);
		return window;
	} catch (error) {
		if (!(error instanceof SecondaryWindowOperationTimeout)) throw error;
		const recovered = await pollForWindow(find, SECONDARY_WINDOW_LOOKUP_TIMEOUT_MS);
		if (recovered) return recovered;
		throw error;
	} finally {
		void createdUnlisten.then((unlisten) => unlisten()).catch(() => {});
		void errorUnlisten.then((unlisten) => unlisten()).catch(() => {});
	}
}

/** Reveals a helper window without letting a lost native callback block retries. */
export async function revealSecondaryWindow(
	window: RevealableSecondaryWindow,
): Promise<void> {
	let active = true;
	const reveal = (async () => {
		await window.show();
		if (!active) return;
		await window.unminimize();
		if (!active) return;
		await window.setFocus();
	})();
	try {
		await withSecondaryWindowTimeout(
			"secondary window reveal",
			reveal,
			SECONDARY_WINDOW_REVEAL_TIMEOUT_MS,
		);
	} finally {
		active = false;
	}
}
