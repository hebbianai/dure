import {
	type Dispatch,
	type RefObject,
	type SetStateAction,
	useCallback,
	useRef,
} from "react";
import { useWorkspaceRuntimeDesktopId } from "@/components/workspace/WorkspaceRuntimeContext";
import type { TerminalBoxCache } from "@/lib/terminal/geometry/terminalBoxCache";
import type { TerminalDocumentResizeSurfaceRegistration } from "@/lib/terminal/geometry/terminalDocumentResizeTransaction";
import type { TerminalPresentationRole } from "@/lib/terminal/presentation/terminalPresentationRoleStore";
import { DEFAULT_TERMINAL_MODEL_BYTES } from "@/lib/workspace/performance/terminalResourceBudget";
import type { TerminalResizeRetryState } from "@/lib/terminal/state/terminalIntentReceiptPolicy";
import type { TerminalAttachTimingEvent } from "@/lib/terminal/terminalAttachPerformance";
import {
	type TerminalResourceRegistration,
	workspacePerformance,
} from "@/lib/workspace/performance/workspacePerformance";
import type { TerminalCanvasRenderer } from "./TerminalCanvasRenderer";
import type {
	PaintedPresentation,
	TerminalProjectionTiming,
} from "./terminalCanvasPresentation";
import { useStructuredTerminalAttachPreparation } from "./useStructuredTerminalAttachPreparation";
import { useTerminalCanvasSurfaceRefresh } from "./useTerminalCanvasSurfaceRefresh";

interface StructuredTerminalAttachmentLifecycleOptions {
	readonly surfaceId: string;
	readonly panelId?: string;
	readonly ensure?: (columns: number, rows: number) => Promise<unknown>;
	readonly containerRef: RefObject<HTMLDivElement | null>;
	readonly surfaceBox: TerminalBoxCache;
	readonly renderer: TerminalCanvasRenderer;
	readonly fontFamily: string;
	readonly fontSize: number;
	readonly lineHeight: number;
	readonly paintedPresentationRef: RefObject<PaintedPresentation | null>;
	readonly setPaintRevision: Dispatch<SetStateAction<number>>;
	readonly holdResizePresentation: () => void;
	readonly resetResizePresentation: () => void;
}

interface StructuredTerminalPerformanceRegistration {
	readonly attachmentId: string;
	readonly registration: TerminalResourceRegistration;
}

export function useStructuredTerminalAttachmentLifecycle({
	surfaceId,
	panelId,
	ensure,
	containerRef,
	surfaceBox,
	renderer,
	fontFamily,
	fontSize,
	lineHeight,
	paintedPresentationRef,
	setPaintRevision,
	holdResizePresentation,
	resetResizePresentation,
}: StructuredTerminalAttachmentLifecycleOptions) {
	const prepareAttach = useStructuredTerminalAttachPreparation({
		ensure,
		containerRef,
		surfaceBox,
		renderer,
		fontFamily,
		fontSize,
		lineHeight,
	});
	const geometryRef = useRef({ columns: 0, rows: 0 });
	const confirmedGeometryRef = useRef({ columns: 0, rows: 0 });
	const hasIssuedGeometryRef = useRef(false);
	const resizeRetryRef = useRef<TerminalResizeRetryState | undefined>(
		undefined,
	);
	const paintedRef = useRef(false);
	const geometryFrameRef = useRef<number | undefined>(undefined);
	const resizeRegistrationRef = useRef<
		TerminalDocumentResizeSurfaceRegistration | undefined
	>(undefined);
	const scheduleGeometryCommit = useTerminalCanvasSurfaceRefresh({
		geometryFrameRef,
		paintedPresentationRef,
		resizeRegistrationRef,
		setPaintRevision,
		invalidateFontMetrics: renderer.invalidateMetrics,
		metricRevision: JSON.stringify([fontFamily, fontSize, lineHeight]),
		holdPresentation: holdResizePresentation,
	});

	const desktopId = useWorkspaceRuntimeDesktopId();
	const performanceRegistrationRef = useRef<
		StructuredTerminalPerformanceRegistration | undefined
	>(undefined);
	const retirePerformanceSurface = useCallback((attachmentId: string) => {
		const current = performanceRegistrationRef.current;
		if (!current || current.attachmentId !== attachmentId) return;
		performanceRegistrationRef.current = undefined;
		current.registration.dispose();
	}, []);
	const recordTerminalAttachPhase = useCallback(
		(event: TerminalAttachTimingEvent) => {
			if (event.phase === "invoke_started") {
				workspacePerformance.markTerminalPresentationRequested(surfaceId);
			}
			workspacePerformance.markTerminalAttachPhase(
				surfaceId,
				event,
				desktopId,
			);
		},
		[desktopId, surfaceId],
	);

	const onAttached = useCallback((attachmentId: string) => {
		resetResizePresentation();
		geometryRef.current = { columns: 0, rows: 0 };
		confirmedGeometryRef.current = { columns: 0, rows: 0 };
		hasIssuedGeometryRef.current = false;
		resizeRetryRef.current = undefined;
		paintedRef.current = false;
		const observation = resizeRegistrationRef.current?.noteGeometryChanged();
		if (observation) scheduleGeometryCommit(observation);
		const previous = performanceRegistrationRef.current;
		performanceRegistrationRef.current = undefined;
		previous?.registration.dispose();
		performanceRegistrationRef.current = {
			attachmentId,
			registration: workspacePerformance.registerTerminal({
				id: surfaceId,
				desktopId: desktopId ?? surfaceId,
				panelId,
				runtime: "hmux",
				renderer: "dom",
				gpuViewportBytes: 0,
				modelBytes: DEFAULT_TERMINAL_MODEL_BYTES,
				visible: true,
			}),
		};
	}, [
		desktopId,
		panelId,
		resetResizePresentation,
		scheduleGeometryCommit,
		surfaceId,
	]);
	const recordTerminalProjection = useCallback(
		(
			attachmentId: string,
			role: TerminalPresentationRole,
			timing: TerminalProjectionTiming,
		) => {
			const current = performanceRegistrationRef.current;
			if (current?.attachmentId !== attachmentId) return;
			current.registration.recordProjection(role, timing);
		},
		[],
	);
	const recordFirstTerminalPaint = useCallback(
		(attachmentId: string) => {
			const current = performanceRegistrationRef.current;
			if (current?.attachmentId !== attachmentId) return;
			workspacePerformance.markTerminalPaint(surfaceId);
		},
		[surfaceId],
	);
	return {
		prepareAttach: ensure ? prepareAttach : undefined,
		onAttached,
		onAttachmentRetired: retirePerformanceSurface,
		recordTerminalAttachPhase,
		recordTerminalProjection,
		recordFirstTerminalPaint,
		geometryRef,
		confirmedGeometryRef,
		hasIssuedGeometryRef,
		resizeRetryRef,
		paintedRef,
		geometryFrameRef,
		resizeRegistrationRef,
		scheduleGeometryCommit,
	};
}
