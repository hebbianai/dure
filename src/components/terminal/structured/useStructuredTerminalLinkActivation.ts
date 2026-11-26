import { type RefObject, useCallback, useEffect, useRef } from "react";
import { useWorkspaceRuntimeDesktopId } from "@/components/workspace/WorkspaceRuntimeContext";
import { openFileViewer } from "@/lib/files/fileViewerPane";
import { homeDir } from "@/lib/ipc";
import { openExternalPath, openExternalUrl } from "@/lib/platform/externalOpen";
import {
	isTerminalLinkGesture,
	type TerminalTextLink,
	terminalLinkDestination,
	terminalViewportLinkAt,
} from "@/lib/terminal/interaction/terminalLinks";
import { getTerminalExecutionLocation } from "@/lib/terminal/terminalExecutionLocationStore";
import type { HmuxPaneBindingV1 } from "@/lib/terminal/terminalBinding";
import { getDockview } from "@/lib/workspace/dock/dockRegistry";
import { detectDesktopPlatform } from "@/lib/workspace/desktop/desktopPlatform";
import { useStore } from "@/store";
import type { PaintedPresentation } from "./terminalCanvasPresentation";

/** The same click slop as a selection drag: farther than this is not a click. */
const CLICK_SLOP_PX = 6;
const platform = detectDesktopPlatform();

interface PendingLinkClick {
	readonly pointerId: number;
	readonly originX: number;
	readonly originY: number;
	readonly link: TerminalTextLink;
	readonly external: boolean;
}

interface StructuredTerminalLinkActivationOptions {
	readonly sessionId: string;
	readonly binding: HmuxPaneBindingV1;
	/** The folder the pane was opened in, until the session reports its own. */
	readonly runtimeWorkingDirectory?: string;
	readonly terminalSurfaceRef: RefObject<HTMLDivElement | null>;
	readonly paintedPresentationRef: {
		readonly current: PaintedPresentation | null;
	};
}

/** Owns the terminal's link gesture. Cmd-click (Ctrl elsewhere) on a URL or
 * file path in the painted frame claims the pointer before selection or mouse
 * reporting see it, and opens the link when the click is released in place.
 * OSC 8 anchors open through the same routing. */
export function useStructuredTerminalLinkActivation(
	options: StructuredTerminalLinkActivationOptions,
) {
	const desktopId = useWorkspaceRuntimeDesktopId();
	const optionsRef = useRef(options);
	optionsRef.current = options;
	const desktopIdRef = useRef(desktopId);
	desktopIdRef.current = desktopId;
	const pendingRef = useRef<PendingLinkClick | null>(null);

	/** Routes the link from the pane's state at the moment it is opened. */
	const activate = useCallback(
		async (link: TerminalTextLink, external: boolean) => {
			const { sessionId, binding, runtimeWorkingDirectory } =
				optionsRef.current;
			const local = binding.source === "local";
			const homeDirectory =
				local && link.kind === "path"
					? await homeDir().catch(() => undefined)
					: undefined;
			const destination = terminalLinkDestination(
				link,
				{
					backend: local
						? { source: "local" }
						: { source: "ssh", hostId: binding.hostId },
					nestedRemote: getTerminalExecutionLocation(sessionId).kind === "ssh",
					workingDirectory:
						useStore.getState().sessionCwd[sessionId] ||
						runtimeWorkingDirectory,
					homeDirectory,
				},
				{ external },
			);
			switch (destination?.kind) {
				case "external_url":
					await openExternalUrl(destination.url);
					return;
				case "external_path":
					await openExternalPath(destination.path);
					return;
				case "file": {
					// The file opens beside the terminal, in this window's Space.
					const desktop = desktopIdRef.current;
					if (!desktop || !getDockview(desktop)) return;
					openFileViewer(
						desktop,
						destination.reveal
							? { ...destination.target, reveal: destination.reveal }
							: destination.target,
					);
					return;
				}
			}
		},
		[],
	);

	const begin = useCallback((event: PointerEvent) => {
		if (!isTerminalLinkGesture(event, platform)) return false;
		const { terminalSurfaceRef, paintedPresentationRef } = optionsRef.current;
		const surface = terminalSurfaceRef.current;
		const presentation = paintedPresentationRef.current;
		const tables = presentation?.frame.frame.tables;
		if (!surface || !presentation || !tables) return false;
		const { frame } = presentation.frame;
		const { cellWidth, rowHeight } = presentation.paint.metrics;
		if (cellWidth <= 0 || rowHeight <= 0) return false;
		const bounds = surface.getBoundingClientRect();
		const link = terminalViewportLinkAt(
			frame.rows.slice(0, frame.viewportRows),
			tables,
			Math.floor((event.clientY - bounds.top) / rowHeight),
			Math.floor((event.clientX - bounds.left) / cellWidth),
		);
		if (!link) return false;
		event.preventDefault();
		pendingRef.current = {
			pointerId: event.pointerId,
			originX: event.clientX,
			originY: event.clientY,
			link,
			external: event.shiftKey,
		};
		return true;
	}, []);

	useEffect(() => {
		const finish = (event: PointerEvent) => {
			const pending = pendingRef.current;
			if (!pending || pending.pointerId !== event.pointerId) return;
			pendingRef.current = null;
			if (
				Math.hypot(
					event.clientX - pending.originX,
					event.clientY - pending.originY,
				) < CLICK_SLOP_PX
			) {
				void activate(pending.link, pending.external);
			}
		};
		const cancel = (event: PointerEvent) => {
			if (pendingRef.current?.pointerId === event.pointerId) {
				pendingRef.current = null;
			}
		};
		const reset = () => {
			pendingRef.current = null;
		};
		window.addEventListener("pointerup", finish);
		window.addEventListener("pointercancel", cancel);
		window.addEventListener("blur", reset);
		return () => {
			window.removeEventListener("pointerup", finish);
			window.removeEventListener("pointercancel", cancel);
			window.removeEventListener("blur", reset);
			pendingRef.current = null;
		};
	}, [activate]);

	const ownsPointer = useCallback(
		(pointerId: number) => pendingRef.current?.pointerId === pointerId,
		[],
	);

	/** Opens an OSC 8 hyperlink's URL through the terminal's link routing. */
	const openHyperlink = useCallback(
		(url: string) => {
			void activate({ kind: "url", url, start: 0, end: url.length }, false);
		},
		[activate],
	);

	return { begin, ownsPointer, openHyperlink };
}
