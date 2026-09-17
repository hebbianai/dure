import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { type RefObject, useCallback, useMemo } from "react";
import type { TerminalEvent } from "@/contracts/terminalStateProtocol";
import {
	handleRemoteHmuxCommandBridgeOsc,
	type RemoteHmuxManagedStartedMarkerV1,
} from "@/lib/hmux/remote/remoteHmuxCommandBridge";
import { t } from "@/lib/i18n";
import { systemNotify } from "@/lib/settings/notify";
import { dispatchTerminalViewportEvent } from "@/lib/terminal/state/terminalViewportEventDispatch";
import { createTerminalBellNotificationHandler } from "@/lib/terminal/terminalBellNotification";
import type { HmuxPaneBindingV1 } from "@/lib/terminal/terminalBinding";
import { useStore } from "@/store";
import type { Provider } from "@/types";

interface StructuredTerminalEventsOptions {
	readonly sessionId: string;
	readonly providerHint?: Provider;
	readonly binding: HmuxPaneBindingV1;
	readonly containerRef: RefObject<HTMLDivElement | null>;
	readonly allowOsc52: boolean;
	readonly onRemoteManagedStarted?: (
		marker: RemoteHmuxManagedStartedMarkerV1,
	) => void;
}

export function useStructuredTerminalEvents({
	sessionId,
	providerHint,
	binding,
	containerRef,
	allowOsc52,
	onRemoteManagedStarted,
}: StructuredTerminalEventsOptions): (event: TerminalEvent) => void {
	const bellNotification = useMemo(
		() =>
			createTerminalBellNotificationHandler({
				sessionId,
				providerHint,
				getState: useStore.getState,
				isVisible: () =>
					document.hasFocus() &&
					(containerRef.current?.contains(document.activeElement) ?? false),
				notify: systemNotify,
				translate: t,
			}),
		[containerRef, providerHint, sessionId],
	);

	return useCallback(
		(event: TerminalEvent) => {
			dispatchTerminalViewportEvent(event, {
				bell: bellNotification,
				writeClipboard: (text) => {
					if (
						!allowOsc52 ||
						!containerRef.current?.contains(document.activeElement)
					) {
						return;
					}
					void writeText(text).catch(() => {});
				},
				notify: (title, body, eventId) => {
					void systemNotify(title, body, {
						eventId: `terminal:${sessionId}:${eventId}`,
					});
				},
				executionMarker: (marker) => {
					// Host preserves the OSC body after `778;` in the typed label;
					// the command-bridge parser consumes that same canonical payload.
					handleRemoteHmuxCommandBridgeOsc(
						marker.label,
						binding,
						(candidate) => onRemoteManagedStarted?.(candidate),
					);
				},
			});
		},
		[
			allowOsc52,
			bellNotification,
			binding,
			containerRef,
			onRemoteManagedStarted,
			sessionId,
		],
	);
}
