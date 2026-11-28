import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";
import { browserLocalStorage } from "@/lib/persistence/windowPresentationStorage";
import { subscribeCurrentWindowFocus } from "@/lib/workspace/window/currentWindowFocus";
import {
	keepOnTopPreferred,
	rememberKeepOnTop,
} from "@/lib/workspace/window/windowKeepOnTop";

export interface WindowKeepOnTop {
	/** Whether the native window is above other apps' windows. */
	readonly keepOnTop: boolean;
	readonly toggle: () => void;
}

/**
 * Keep this window above other apps' windows on its own desktop. The native
 * window is the source of truth: its level is read on mount and again on
 * every focus change, so a window manager that ignores the request, or
 * applies it late, shows up as it is. The person's choice is saved per window
 * label; a read that finds the window at the normal level does not change it.
 */
export function useWindowKeepOnTop(): WindowKeepOnTop {
	const [keepOnTop, setKeepOnTop] = useState(() =>
		keepOnTopPreferred(browserLocalStorage(), getCurrentWindow().label),
	);
	const keepOnTopRef = useRef(keepOnTop);
	keepOnTopRef.current = keepOnTop;
	// Bumped by every level change this window asks for, so a read that
	// started before it cannot overwrite the newer state.
	const revisionRef = useRef(0);
	const changingRef = useRef(false);
	const disposedRef = useRef(false);

	const apply = useCallback(async (next: boolean) => {
		const win = getCurrentWindow();
		revisionRef.current += 1;
		changingRef.current = true;
		try {
			await win.setAlwaysOnTop(next);
			// The resolved request is trusted over an immediate read: some
			// platforms apply the level on a later turn of their event loop.
			if (!disposedRef.current) setKeepOnTop(next);
			return true;
		} catch (error) {
			console.warn("[window] keep on top was not applied", error);
			return false;
		} finally {
			changingRef.current = false;
		}
	}, []);

	useEffect(() => {
		disposedRef.current = false;
		const win = getCurrentWindow();
		let reconciled = false;
		const read = () => {
			const revision = revisionRef.current;
			void win
				.isAlwaysOnTop()
				.then((onTop) => {
					if (disposedRef.current || revision !== revisionRef.current) return;
					setKeepOnTop(onTop);
					if (reconciled) return;
					reconciled = true;
					// A window created without the saved level (or by another
					// owner) takes it once; a refusal leaves the toggle off.
					if (!onTop && keepOnTopPreferred(browserLocalStorage(), win.label))
						void apply(true);
				})
				.catch(() => {});
		};
		const stopFocus = subscribeCurrentWindowFocus(read);
		return () => {
			disposedRef.current = true;
			stopFocus();
		};
	}, [apply]);

	const toggle = useCallback(() => {
		if (changingRef.current) return;
		const next = !keepOnTopRef.current;
		void apply(next).then((applied) => {
			if (applied)
				rememberKeepOnTop(browserLocalStorage(), getCurrentWindow().label, next);
		});
	}, [apply]);

	return { keepOnTop, toggle };
}
