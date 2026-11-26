import type { PointerEvent as ReactPointerEvent } from "react";
import { PointerKind } from "@/contracts/terminalStateProtocol";
import type { useStructuredTerminalPointerInput } from "./useStructuredTerminalPointerInput";

type SurfacePointerEvent = ReactPointerEvent<HTMLDivElement>;

interface StructuredTerminalSurfacePointerOptions {
	/** The view holds a complete Host frame. */
	readonly frameInstalled: boolean;
	/** The painted presentation belongs to the current attachment. */
	readonly painted: boolean;
	readonly inputDisabled: boolean;
	/** The app in the terminal asked for mouse reports. */
	readonly mouseReporting: boolean;
	readonly focusPaneInput: () => void;
	readonly links: {
		readonly begin: (event: PointerEvent) => boolean;
		readonly ownsPointer: (pointerId: number) => boolean;
	};
	readonly selection: {
		readonly begin: (event: PointerEvent, reportClick: boolean) => boolean;
		readonly ownsPointer: (pointerId: number) => boolean;
		readonly cancel: (pointerId?: number) => void;
	};
	readonly issuePointer: ReturnType<typeof useStructuredTerminalPointerInput>;
}

/** Routes each pointer on the terminal viewport to one owner, in order: a
 * link click, a local selection drag, then mouse reports to the app. */
export function structuredTerminalSurfacePointerHandlers({
	frameInstalled,
	painted,
	inputDisabled,
	mouseReporting,
	focusPaneInput,
	links,
	selection,
	issuePointer,
}: StructuredTerminalSurfacePointerOptions) {
	return {
		onPointerDown: (event: SurfacePointerEvent) => {
			if (!frameInstalled || !painted) {
				// Retain the explicit click until input is ready; no pointer
				// or keyboard intent may reach an unpainted attachment.
				if (event.button === 0) focusPaneInput();
				event.preventDefault();
				return;
			}
			if (links.begin(event.nativeEvent)) return;
			const reportClick = !inputDisabled && mouseReporting && !event.shiftKey;
			const selecting = selection.begin(event.nativeEvent, reportClick);
			if (!selecting && reportClick) {
				issuePointer(event.nativeEvent, PointerKind.DOWN);
			}
		},
		onPointerMove: (event: SurfacePointerEvent) => {
			if (!painted) return;
			if (links.ownsPointer(event.pointerId)) return;
			if (selection.ownsPointer(event.pointerId)) return;
			if (mouseReporting) issuePointer(event.nativeEvent, PointerKind.MOVE);
		},
		onPointerUp: (event: SurfacePointerEvent) => {
			if (links.ownsPointer(event.pointerId)) return;
			if (selection.ownsPointer(event.pointerId)) return;
			if (!inputDisabled && !event.shiftKey && painted && mouseReporting) {
				focusPaneInput();
				issuePointer(event.nativeEvent, PointerKind.UP);
			}
		},
		onPointerCancel: (event: SurfacePointerEvent) => {
			selection.cancel(event.pointerId);
		},
	};
}
