import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { visibleActiveDesktopId } from "@/lib/workspace/desktop/activeDesktop";
import {
	removeDesktopVisibilityLease,
	writeDesktopVisibilityLease,
} from "@/lib/workspace/desktop/desktopVisibilityLease";
import { subscribeCurrentWindowFocus } from "@/lib/workspace/window/currentWindowFocus";
import { useStore } from "@/store";

const DESKTOP_VISIBILITY_HEARTBEAT_MS = 2_000;

function currentVisibleDesktopId(): string | undefined {
	const state = useStore.getState();
	return visibleActiveDesktopId(state.spaces, state.activeSpaceId);
}

/** Publish one window's ephemeral presentation ownership. The initial and
 * desktop-switch write assumes visible until native state says otherwise:
 * over-protection can only defer work, while a false off-screen report could
 * retire a provider the user just brought on screen. */
export function installDesktopVisibilityLeasePublisher(
	fixedDesktopId?: string,
): () => void {
	const windowLabel = getCurrentWebviewWindow().label;
	const nativeWindow = getCurrentWindow();
	const getDesktopId = () => fixedDesktopId ?? currentVisibleDesktopId();
	let disposed = false;
	let lastVisible = true;
	let refreshGeneration = 0;
	let publishedDesktopId: string | undefined;

	const publish = (visible = lastVisible) => {
		if (disposed) return;
		const desktopId = getDesktopId();
		if (!desktopId) {
			removeDesktopVisibilityLease(windowLabel);
			publishedDesktopId = undefined;
			return;
		}
		lastVisible = visible;
		publishedDesktopId = desktopId;
		writeDesktopVisibilityLease({
			schemaVersion: 1,
			windowLabel,
			desktopId,
			visible,
			updatedAtMs: Date.now(),
		});
	};

	const publishDesktopChange = () => {
		const desktopId = getDesktopId();
		if (desktopId === publishedDesktopId) return;
		// The newly selected desktop is protected synchronously, before either
		// a timer pass or the async native visibility query can run.
		lastVisible = true;
		publish(true);
		void refreshNativeVisibility();
	};

	const refreshNativeVisibility = async () => {
		const generation = ++refreshGeneration;
		try {
			const [visible, minimized] = await Promise.all([
				nativeWindow.isVisible(),
				nativeWindow.isMinimized(),
			]);
			if (disposed || generation !== refreshGeneration) return;
			publish(visible && !minimized);
		} catch {
			// Keep the conservative previous report. Its heartbeat eventually
			// expires if native state remains unknowable.
			publish();
		}
	};

	publish(true);
	void refreshNativeVisibility();
	const heartbeat = window.setInterval(
		() => void refreshNativeVisibility(),
		DESKTOP_VISIBILITY_HEARTBEAT_MS,
	);
	const unsubscribeStore = fixedDesktopId
		? () => {}
		: useStore.subscribe((state, previous) => {
				if (
					state.activeSpaceId !== previous.activeSpaceId ||
					state.spaces !== previous.spaces
				) {
					publishDesktopChange();
				}
			});
	const onForeground = () => {
		if (document.visibilityState !== "hidden") publish(true);
		void refreshNativeVisibility();
	};
	window.addEventListener("focus", onForeground);
	document.addEventListener("visibilitychange", onForeground);
	const stopFocusWatch = subscribeCurrentWindowFocus((focused) => {
		if (focused) publish(true);
		void refreshNativeVisibility();
	});

	return () => {
		disposed = true;
		refreshGeneration += 1;
		window.clearInterval(heartbeat);
		unsubscribeStore();
		stopFocusWatch();
		window.removeEventListener("focus", onForeground);
		document.removeEventListener("visibilitychange", onForeground);
		removeDesktopVisibilityLease(windowLabel);
	};
}
