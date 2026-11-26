import {
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { useWorkspaceRuntimeDesktopId } from "@/components/workspace/WorkspaceRuntimeContext";
import { openFileViewer } from "@/lib/files/fileViewerPane";
import { homeDir } from "@/lib/ipc";
import { resolveSshHostDureBackendRouteAuthority } from "@/lib/ipc/dureBackendProfiles";
import { openExternalPath, openExternalUrl } from "@/lib/platform/externalOpen";
import type { TerminalCellSpan } from "@/lib/terminal/geometry/terminalCellSpan";
import {
	isTerminalLinkGesture,
	isTerminalLinkModifier,
	type TerminalLinkDestination,
	type TerminalTextLink,
	type TerminalViewportLink,
	terminalLinkDestination,
	terminalViewportLinkAt,
} from "@/lib/terminal/interaction/terminalLinks";
import type { HmuxPaneBindingV1 } from "@/lib/terminal/terminalBinding";
import { getTerminalExecutionLocation } from "@/lib/terminal/terminalExecutionLocationStore";
import { detectDesktopPlatform } from "@/lib/workspace/desktop/desktopPlatform";
import { getDockview } from "@/lib/workspace/dock/dockRegistry";
import { openBrowserPanelOn } from "@/lib/workspace/dock/openBrowserPanel";
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

interface LinkModifiers {
	/** Cmd on macOS, Ctrl elsewhere. */
	readonly held: boolean;
	/** Shift: the link goes to the operating system. */
	readonly external: boolean;
}

type ModifierEvent = Pick<
	PointerEvent,
	"metaKey" | "ctrlKey" | "altKey" | "shiftKey"
>;

const NO_MODIFIERS: LinkModifiers = { held: false, external: false };

function linkModifiers(event: ModifierEvent): LinkModifiers {
	return {
		held: isTerminalLinkModifier(event, platform),
		external: event.shiftKey,
	};
}

function spansKey(spans: readonly TerminalCellSpan[] | null): string {
	return spans
		? spans
				.map((span) => `${span.row}:${span.startColumn}-${span.endColumn}`)
				.join(",")
		: "";
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

/** Owns the terminal's link gesture. While Cmd (Ctrl elsewhere) is held, the
 * URL or file path under the pointer in the painted frame is marked, and a
 * click on it claims the pointer before selection or mouse reporting see it
 * and opens the link when released in place. Only links a click would open
 * are marked. OSC 8 anchors open through the same routing. */
export function useStructuredTerminalLinkActivation(
	options: StructuredTerminalLinkActivationOptions,
) {
	const desktopId = useWorkspaceRuntimeDesktopId();
	const optionsRef = useRef(options);
	optionsRef.current = options;
	const desktopIdRef = useRef(desktopId);
	desktopIdRef.current = desktopId;
	const pendingRef = useRef<PendingLinkClick | null>(null);
	const homeDirectoryRef = useRef<string | undefined>(undefined);
	const pointerRef = useRef<{ clientX: number; clientY: number } | null>(null);
	const modifiersRef = useRef<LinkModifiers>(NO_MODIFIERS);
	const hoveredKeyRef = useRef("");
	const [hovered, setHovered] = useState<readonly TerminalCellSpan[] | null>(
		null,
	);

	/** Reads the local home folder once, for `~/` in a local pane. True when
	 * it was read by this call. */
	const readHomeDirectory = useCallback(async () => {
		if (
			homeDirectoryRef.current !== undefined ||
			optionsRef.current.binding.source !== "local"
		) {
			return false;
		}
		homeDirectoryRef.current = await homeDir().catch(() => undefined);
		return homeDirectoryRef.current !== undefined;
	}, []);

	/** Where the link goes from the pane's state now, or null when a click on
	 * it would open nothing. */
	const destinationOf = useCallback(
		(
			link: TerminalTextLink,
			external: boolean,
		): TerminalLinkDestination | null => {
			const { sessionId, binding, runtimeWorkingDirectory } =
				optionsRef.current;
			const destination = terminalLinkDestination(
				link,
				{
					backend:
						binding.source === "local"
							? { source: "local" }
							: { source: "ssh", hostId: binding.hostId },
					nestedRemote: getTerminalExecutionLocation(sessionId).kind === "ssh",
					workingDirectory:
						useStore.getState().sessionCwd[sessionId] ||
						runtimeWorkingDirectory,
					homeDirectory: homeDirectoryRef.current,
				},
				{ external },
			);
			// A file opens beside the terminal, in this window's Space.
			if (destination?.kind === "file") {
				const desktop = desktopIdRef.current;
				if (!desktop || !getDockview(desktop)) return null;
			}
			return destination;
		},
		[],
	);

	/** Routes the link from the pane's state at the moment it is opened. */
	const activate = useCallback(
		async (link: TerminalTextLink, external: boolean) => {
			if (link.kind === "path") await readHomeDirectory();
			const destination = destinationOf(link, external);
			switch (destination?.kind) {
				case "external_url":
					await openExternalUrl(destination.url);
					return;
				case "external_path":
					await openExternalPath(destination.path);
					return;
				case "host_browser": {
					// The Browser runs on the backend that serves the pane's Host,
					// where the server listens. Without one, or without a Space to
					// place it in, the address goes to the operating system.
					const route = await resolveSshHostDureBackendRouteAuthority(
						destination.hostId,
						useStore.getState().sshHosts,
					).catch(() => undefined);
					const desktop = desktopIdRef.current;
					const api = desktop ? getDockview(desktop) : undefined;
					if (!route || !api) {
						await openExternalUrl(destination.url);
						return;
					}
					openBrowserPanelOn(api, destination.url, route.profileId);
					return;
				}
				case "file": {
					const desktop = desktopIdRef.current;
					if (!desktop) return;
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
		[destinationOf, readHomeDirectory],
	);

	/** The link painted under a viewport point, if any. */
	const linkAt = useCallback(
		(clientX: number, clientY: number): TerminalViewportLink | null => {
			const { terminalSurfaceRef, paintedPresentationRef } = optionsRef.current;
			const surface = terminalSurfaceRef.current;
			const presentation = paintedPresentationRef.current;
			const tables = presentation?.frame.frame.tables;
			if (!surface || !presentation || !tables) return null;
			const { frame } = presentation.frame;
			const { cellWidth, rowHeight } = presentation.paint.metrics;
			if (cellWidth <= 0 || rowHeight <= 0) return null;
			const bounds = surface.getBoundingClientRect();
			return terminalViewportLinkAt(
				frame.rows.slice(0, frame.viewportRows),
				tables,
				Math.floor((clientY - bounds.top) / rowHeight),
				Math.floor((clientX - bounds.left) / cellWidth),
			);
		},
		[],
	);

	/** Marks the link under the pointer while the modifier is held. */
	const refresh = useCallback(
		function refreshHoveredLink() {
			const pointer = pointerRef.current;
			const modifiers = modifiersRef.current;
			const hit =
				pointer && modifiers.held
					? linkAt(pointer.clientX, pointer.clientY)
					: null;
			const spans =
				hit && destinationOf(hit.link, modifiers.external) ? hit.spans : null;
			if (hit?.link.kind === "path") {
				// `~/` resolves once the home folder is known.
				void readHomeDirectory().then((read) => {
					if (read) refreshHoveredLink();
				});
			}
			const key = spansKey(spans);
			if (key === hoveredKeyRef.current) return;
			hoveredKeyRef.current = key;
			setHovered(spans);
		},
		[destinationOf, linkAt, readHomeDirectory],
	);

	/** Follows the pointer over the painted terminal; null when it left. */
	const track = useCallback(
		(event: PointerEvent | null) => {
			pointerRef.current = event
				? { clientX: event.clientX, clientY: event.clientY }
				: null;
			if (event) modifiersRef.current = linkModifiers(event);
			refresh();
		},
		[refresh],
	);

	const begin = useCallback(
		(event: PointerEvent) => {
			if (!isTerminalLinkGesture(event, platform)) return false;
			const hit = linkAt(event.clientX, event.clientY);
			if (!hit) return false;
			event.preventDefault();
			pendingRef.current = {
				pointerId: event.pointerId,
				originX: event.clientX,
				originY: event.clientY,
				link: hit.link,
				external: event.shiftKey,
			};
			return true;
		},
		[linkAt],
	);

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
		// Pressing or releasing the modifier over a still pointer counts too.
		const followModifiers = (event: KeyboardEvent) => {
			const next = linkModifiers(event);
			const current = modifiersRef.current;
			if (next.held === current.held && next.external === current.external) {
				return;
			}
			modifiersRef.current = next;
			if (pointerRef.current) refresh();
		};
		// A modifier released in another window never reaches this one.
		const reset = () => {
			pendingRef.current = null;
			modifiersRef.current = NO_MODIFIERS;
			refresh();
		};
		window.addEventListener("pointerup", finish);
		window.addEventListener("pointercancel", cancel);
		window.addEventListener("keydown", followModifiers, true);
		window.addEventListener("keyup", followModifiers, true);
		window.addEventListener("blur", reset);
		return () => {
			window.removeEventListener("pointerup", finish);
			window.removeEventListener("pointercancel", cancel);
			window.removeEventListener("keydown", followModifiers, true);
			window.removeEventListener("keyup", followModifiers, true);
			window.removeEventListener("blur", reset);
			pendingRef.current = null;
		};
	}, [activate, refresh]);

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

	return {
		begin,
		ownsPointer,
		openHyperlink,
		track,
		/** Re-reads the link under the pointer after a paint. */
		refresh,
		/** The cells of the marked link, or null. */
		hovered,
	};
}
