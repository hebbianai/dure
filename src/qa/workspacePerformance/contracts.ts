import type { FrameStats } from "@/lib/platform/frameSampler";
import type {
	QaRuntimeErrorCursor,
	QaRuntimeErrorSnapshot,
} from "@/lib/qa/qaRuntimeErrorLedger";
import type { terminalStableDiagnosticSnapshot } from "@/lib/terminal/qa/terminalStableDiagnostics";
import type { WorkspaceTransitionSample } from "@/lib/workspace/performance/workspacePerformance";
import type { NativePaneFocusEvidence } from "./nativePaneFocus";
import type { WorkspaceRetentionEvidence } from "./retention";
import type { WorkspacePerformanceSashGeometryEvidence } from "./sashGeometry";
import type { WorkspacePerformanceSashSelectionEvidence } from "./sashSelection";

export interface WorkspacePerformanceFocusSnapshot {
	documentFocused: boolean;
	documentVisibility: DocumentVisibilityState;
	activeSpaceId?: string;
	activePanelId?: string;
	activeElement: string | null;
}

export interface WorkspacePerformanceFocusTraceEntry
	extends WorkspacePerformanceFocusSnapshot {
	atMs: number;
	event: "focusin" | "focusout" | "pointerdown";
	target?: string;
	relatedTarget?: string;
}

export interface WorkspacePerformanceFailureEvidence {
	terminalDiagnostics: ReturnType<typeof terminalStableDiagnosticSnapshot>;
	transitions: readonly WorkspaceTransitionSample[];
	focusTrace: readonly WorkspacePerformanceFocusTraceEntry[];
}

declare global {
	interface Window {
		__DURE_WORKSPACE_PERFORMANCE_QA__?: {
			state: "running" | "complete" | "failed";
			phase: string;
			error?: string;
			focus: WorkspacePerformanceFocusSnapshot;
			scenario?: string;
			terminalDiagnostics?: ReturnType<typeof terminalStableDiagnosticSnapshot>;
			transitions?: readonly WorkspaceTransitionSample[];
			measurements?: {
				globalQuiescenceMs?: number;
				providerInputReadyMs?: number;
				steadyStateQuiescenceMs?: number;
				steadyStateFrames?: FrameStats;
			};
			structuredTerminalObservations?: {
				focusedTerminalIds: readonly string[];
				hostReceiptTerminalIds: readonly string[];
				projectedTerminalIds: readonly string[];
			};
			sashResize?: WorkspacePerformanceSashGeometryEvidence;
			sashSelection?: WorkspacePerformanceSashSelectionEvidence;
			sashTarget?: { readonly x: number; readonly y: number };
			nativeFocus?: NativePaneFocusEvidence;
			retention?: WorkspaceRetentionEvidence;
			runtimeErrorScope?: QaRuntimeErrorCursor;
			runtimeErrors?: QaRuntimeErrorSnapshot;
		};
	}
}
