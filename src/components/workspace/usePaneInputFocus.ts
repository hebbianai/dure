import type { IDockviewPanelProps } from "dockview-react";
import { type RefObject, useCallback, useLayoutEffect, useRef } from "react";
import { terminalRecoveryFocusTracker } from "@/lib/terminal/terminalRecoveryFocus";
import {
	beginPaneContentFocus,
	cancelPaneContentFocus,
	consumePaneContentFocus,
	currentPaneContentFocus,
	type PaneContentFocusRequest,
} from "@/lib/workspace/pane/paneContentFocusHandoff";
import {
	currentWindowIsInputReady,
	subscribeCurrentWindowInputReady,
} from "@/lib/workspace/window/currentWindowFocus";

/** One focus transaction for both Chat composers and terminal input helpers. */
export function usePaneInputFocus(options: {
	readonly paneApi?: IDockviewPanelProps["api"];
	readonly inputRef: RefObject<HTMLTextAreaElement | null>;
	readonly inputReady: boolean;
	readonly onRequest?: (request: PaneContentFocusRequest) => void;
	readonly onFocusStart?: (
		request: PaneContentFocusRequest,
		startedAt: number,
	) => void;
	readonly onFocused?: (
		request: PaneContentFocusRequest,
		durationMs: number,
	) => void;
	readonly onCancel?: () => void;
	readonly onCommit?: (request: PaneContentFocusRequest) => void;
}): () => void {
	const latest = useRef(options);
	latest.current = options;
	const tryFocus = useRef((): PaneContentFocusRequest | undefined => undefined);
	tryFocus.current = () => {
		const { paneApi, inputRef, inputReady } = latest.current;
		if (!paneApi) return;
		const request = currentPaneContentFocus(paneApi);
		if (!request) return;
		if (
			!paneApi.isActive ||
			!paneApi.isVisible ||
			!paneApi.isGroupActive ||
			!terminalRecoveryFocusTracker.unchanged(request.focusRevision)
		) {
			cancelPaneContentFocus(paneApi, request);
			latest.current.onCancel?.();
			return;
		}
		// Window activation and input mounting may settle in either order.
		// Neither readiness edge creates a new focus request.
		if (!currentWindowIsInputReady()) return;
		const input = inputRef.current;
		if (!inputReady || !input || input.disabled) return;
		latest.current.onRequest?.(request);
		const startedAt = performance.now();
		latest.current.onFocusStart?.(request, startedAt);
		input.focus({ preventScroll: true });
		// Output selection can move WebKit's editing caret without changing
		// activeElement. Reclaim the helper's append position on explicit focus.
		input.setSelectionRange(input.value.length, input.value.length);
		const durationMs = Math.max(0, performance.now() - startedAt);
		if (
			input.ownerDocument.activeElement !== input ||
			!consumePaneContentFocus(paneApi, request)
		) {
			latest.current.onCancel?.();
			return;
		}
		latest.current.onFocused?.(request, durationMs);
		return request;
	};
	const focusInput = useCallback(() => {
		const { paneApi, inputRef, inputReady } = latest.current;
		if (!paneApi) {
			// Standalone surfaces have no Dockview focus transaction to retain.
			const input = inputRef.current;
			if (!inputReady || !input || input.disabled) return;
			input.focus({ preventScroll: true });
			input.setSelectionRange(input.value.length, input.value.length);
			return;
		}
		const pending = currentPaneContentFocus(paneApi);
		const request =
			pending && terminalRecoveryFocusTracker.unchanged(pending.focusRevision)
				? pending
				: beginPaneContentFocus(paneApi);
		latest.current.onRequest?.(request);
		tryFocus.current();
		latest.current.onCommit?.(request);
	}, []);

	useLayoutEffect(() => {
		const paneApi = options.paneApi;
		if (!paneApi) return;
		const cancel = () => {
			cancelPaneContentFocus(paneApi);
			latest.current.onCancel?.();
		};
		const onWillFocus: Parameters<typeof paneApi.group.api.onWillFocus>[0] = (
			event,
		) => {
			if (!paneApi.isActive || !paneApi.isVisible || !paneApi.isGroupActive) {
				latest.current.onCancel?.();
				return;
			}
			event.preventDefault();
			focusInput();
		};
		let willFocus = paneApi.group.api.onWillFocus(onWillFocus);
		const group = paneApi.onDidGroupChange(() => {
			willFocus.dispose();
			willFocus = paneApi.group.api.onWillFocus(onWillFocus);
		});
		const active = paneApi.onDidActiveChange(({ isActive }) => {
			if (!isActive) cancel();
		});
		const visible = paneApi.onDidVisibilityChange(({ isVisible }) => {
			if (!isVisible) cancel();
		});
		const activeGroup = paneApi.onDidActiveGroupChange(({ isActive }) => {
			if (!isActive) cancel();
		});
		let wasReady = false;
		const stopWindowInputReady = subscribeCurrentWindowInputReady((ready) => {
			const lostFocus = wasReady && !ready;
			wasReady = ready;
			if (!ready) {
				// An initial inactive snapshot is not a new blur. Retain the
				// explicit activation request, but cancel on actual focus loss.
				if (lostFocus) cancel();
				return;
			}
			const request = tryFocus.current();
			if (request) latest.current.onCommit?.(request);
		});
		return () => {
			latest.current.onCancel?.();
			stopWindowInputReady();
			group.dispose();
			willFocus.dispose();
			active.dispose();
			visible.dispose();
			activeGroup.dispose();
		};
	}, [options.paneApi, focusInput]);

	// A late mount or newly enabled input may accept only the retained request;
	// activation, provider updates and unrelated renders never create one.
	useLayoutEffect(() => {
		const request = tryFocus.current();
		if (request) latest.current.onCommit?.(request);
	});

	return focusInput;
}
