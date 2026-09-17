import { useCallback, useRef, useSyncExternalStore } from "react";
import { StructuredTerminalView } from "@/components/terminal/structured/StructuredTerminalView";
import type { StructuredTerminalViewProps } from "@/components/terminal/structured/structuredTerminalViewContract";
import type { TerminalViewProps } from "@/components/terminal/TerminalViewProps";
import {
	useWorkspaceRuntimeActive,
	useWorkspaceTerminalPresentationHover,
} from "@/components/workspace/WorkspaceRuntimeContext";
import { cloneTerminalPresentationSnapshot } from "@/lib/terminal/presentation/terminalPresentationSnapshot";

const readDocumentVisibility = () => document.visibilityState === "visible";
const readServerDocumentVisibility = () => true;

/** Releases the active desktop's transport while the window is hidden, keeping
 * the last committed pixels until the replacement attachment has completed its
 * first paint. Retained hidden-desktop presentations stay attached: releasing
 * them too would make every window restore re-attach all warm desktops at
 * once, ahead of the panes the user is actually looking at. */
export function VisibilityRetainedStructuredTerminal({
	binding,
	...props
}: TerminalViewProps & StructuredTerminalViewProps) {
	const workspaceActive = useWorkspaceRuntimeActive();
	const workspaceActiveRef = useRef(workspaceActive);
	workspaceActiveRef.current = workspaceActive;
	const liveHostRef = useRef<HTMLDivElement>(null);
	const snapshotHostRef = useRef<HTMLDivElement>(null);
	const setHovered = useWorkspaceTerminalPresentationHover(props.paneApi?.id);
	const livePresentationPaintedRef = useRef(false);
	const retireLivePresentation = useCallback(() => {
		if (livePresentationPaintedRef.current) {
			const liveHost = liveHostRef.current;
			const snapshotHost = snapshotHostRef.current;
			if (liveHost && snapshotHost) {
				const snapshot = cloneTerminalPresentationSnapshot(liveHost);
				if (snapshot) snapshotHost.replaceChildren(snapshot);
			}
		}
		livePresentationPaintedRef.current = false;
	}, []);
	const clearSnapshot = useCallback(() => {
		snapshotHostRef.current?.replaceChildren();
	}, []);
	const subscribeDocumentVisibility = useCallback(
		(listener: () => void) => {
			const handleVisibilityChange = () => {
				// Only the active desktop releases its live view below, so only it
				// may cover itself with the snapshot until the replacement paints.
				if (!readDocumentVisibility() && workspaceActiveRef.current) {
					retireLivePresentation();
				}
				listener();
			};
			document.addEventListener("visibilitychange", handleVisibilityChange);
			return () =>
				document.removeEventListener(
					"visibilitychange",
					handleVisibilityChange,
				);
		},
		[retireLivePresentation],
	);
	const documentVisible = useSyncExternalStore(
		subscribeDocumentVisibility,
		readDocumentVisibility,
		readServerDocumentVisibility,
	);
	const onFirstPaint = useCallback(() => {
		livePresentationPaintedRef.current = true;
		clearSnapshot();
		props.onFirstPaint?.();
	}, [clearSnapshot, props.onFirstPaint]);

	return (
		<div
			data-pane-surface="own"
			className="relative h-full w-full overflow-hidden bg-surface-terminal"
			onPointerEnter={() => setHovered(true)}
			onPointerLeave={() => setHovered(false)}
		>
			<div
				ref={snapshotHostRef}
				aria-hidden="true"
				data-testid="terminal-presentation-snapshot"
				className="pointer-events-none absolute inset-0 z-[1] size-full select-none overflow-hidden"
			/>
			{documentVisible || !workspaceActive ? (
				<div ref={liveHostRef} className="absolute inset-0 size-full">
					<StructuredTerminalView
						{...props}
						binding={binding}
						onFirstPaint={onFirstPaint}
					/>
				</div>
			) : null}
		</div>
	);
}
