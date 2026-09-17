import type { IDockviewPanelProps } from "dockview-react";
import { type RefObject, useCallback, useRef } from "react";
import { usePaneInputFocus } from "@/components/workspace/usePaneInputFocus";
import { useWorkspaceRuntimeDesktopId } from "@/components/workspace/WorkspaceRuntimeContext";
import { schedulePostPaint } from "@/lib/scheduling/postPaint";
import { terminalRecoveryFocusTracker } from "@/lib/terminal/terminalRecoveryFocus";
import {
	currentPaneContentFocus,
	type PaneContentFocusRequest,
} from "@/lib/workspace/pane/paneContentFocusHandoff";
import type { TerminalInputFocusHandlerTiming } from "@/lib/workspace/performance/workspacePaneFocusPerformance";
import { workspacePerformance } from "@/lib/workspace/performance/workspacePerformance";
import { currentWindowIsFocused } from "@/lib/workspace/window/currentWindowFocus";

interface PaneFocusObservation {
	readonly sequence: number;
	readonly desktopId: string;
	readonly panelId: string;
	readonly identity: symbol;
	readonly request?: PaneContentFocusRequest;
	cancelPostPaint(): void;
	focusRevision: number | undefined;
}

/**
 * Accepts Dockview's explicit focus transaction for one exact terminal pane.
 * Activation alone is intentionally insufficient: several split groups can be
 * active at once, while browser keyboard ownership is exclusive.
 */
export function useStructuredTerminalPaneFocus(options: {
	readonly paneApi?: IDockviewPanelProps["api"];
	readonly inputRef: RefObject<HTMLTextAreaElement | null>;
	readonly surfaceId: string;
	readonly inputReady: boolean;
}): {
	focusPaneInput(): void;
	recordInputFocusHandler(timing: TerminalInputFocusHandlerTiming): void;
} {
	const desktopId = useWorkspaceRuntimeDesktopId();
	const focusObservationRef = useRef<PaneFocusObservation | undefined>(
		undefined,
	);
	const abortFocusObservation = useCallback(
		(expected?: PaneFocusObservation) => {
			const observation = focusObservationRef.current;
			if (!observation || (expected && observation !== expected)) return;
			focusObservationRef.current = undefined;
			observation.cancelPostPaint();
			workspacePerformance.abortPaneFocus(observation.sequence);
		},
		[],
	);
	const beginFocusObservation = useCallback(
		(
			paneApi: IDockviewPanelProps["api"],
			identity: symbol,
			request?: PaneContentFocusRequest,
		) => {
			const current = focusObservationRef.current;
			if (current?.identity === identity) return current;
			current?.cancelPostPaint();
			const measuredDesktopId = desktopId ?? options.surfaceId;
			const sequence = workspacePerformance.beginPaneFocus(
				measuredDesktopId,
				paneApi.id,
				true,
				request?.requestedAt,
			);
			const observation: PaneFocusObservation = {
				sequence,
				desktopId: measuredDesktopId,
				panelId: paneApi.id,
				identity,
				request,
				cancelPostPaint: () => {},
				focusRevision: undefined,
			};
			focusObservationRef.current = observation;
			globalThis.queueMicrotask(() =>
				workspacePerformance.markPaneFocusEventMicrotask(sequence),
			);
			observation.cancelPostPaint = schedulePostPaint(
				paneApi.getWindow(),
				() => {
					if (focusObservationRef.current !== observation) return;
					const input = options.inputRef.current;
					const pendingIsCurrent =
						observation.request !== undefined &&
						currentPaneContentFocus(paneApi) === observation.request &&
						terminalRecoveryFocusTracker.unchanged(
							observation.request.focusRevision,
						);
					const focusedInputIsCurrent =
						input !== null &&
						input.ownerDocument.activeElement === input &&
						observation.focusRevision !== undefined &&
						terminalRecoveryFocusTracker.unchanged(observation.focusRevision);
					if (
						!paneApi.isActive ||
						!paneApi.isVisible ||
						!paneApi.isGroupActive ||
						!currentWindowIsFocused() ||
						(!pendingIsCurrent && !focusedInputIsCurrent)
					) {
						abortFocusObservation();
						return;
					}
					workspacePerformance.markPaneFocusPaint(sequence);
				},
				{
					onTask: () =>
						workspacePerformance.markPaneFocusEventMessageTask(sequence),
					onFrame: () => workspacePerformance.markPaneFocusFrame(sequence),
				},
			);
			return observation;
		},
		[abortFocusObservation, desktopId, options.inputRef, options.surfaceId],
	);
	const recordFocusedInput = useCallback(
		(
			input: HTMLTextAreaElement,
			observation: PaneFocusObservation,
			focusCallMs: number,
		) => {
			const cancelFocusCall = () => {
				workspacePerformance.cancelTerminalInputFocusCall(
					observation.sequence,
					observation.desktopId,
					observation.panelId,
				);
				return false;
			};
			if (input.ownerDocument.activeElement !== input) return cancelFocusCall();
			if (focusObservationRef.current !== observation) return cancelFocusCall();
			observation.focusRevision = terminalRecoveryFocusTracker.snapshot();
			workspacePerformance.markTerminalInputFocus(
				observation.desktopId,
				observation.panelId,
				focusCallMs,
			);
			return true;
		},
		[],
	);

	const recordInputFocusHandler = useCallback(
		(timing: TerminalInputFocusHandlerTiming) => {
			const paneApi = options.paneApi;
			if (!paneApi) return;
			workspacePerformance.markTerminalInputFocusHandler(
				desktopId ?? options.surfaceId,
				paneApi.id,
				timing,
			);
		},
		[desktopId, options.paneApi, options.surfaceId],
	);

	const focusPaneInput = usePaneInputFocus({
		paneApi: options.paneApi,
		inputRef: options.inputRef,
		inputReady: options.inputReady,
		onRequest: (request) => {
			if (!options.paneApi) return;
			if (focusObservationRef.current?.request !== request)
				abortFocusObservation();
			beginFocusObservation(options.paneApi, request.generation, request);
		},
		onFocusStart: (_request, startedAt) => {
			const observation = focusObservationRef.current;
			if (!observation) return;
			workspacePerformance.markTerminalInputFocusCallStart(
				observation.desktopId,
				observation.panelId,
				startedAt,
			);
		},
		onFocused: (_request, durationMs) => {
			const observation = focusObservationRef.current;
			const input = options.inputRef.current;
			if (options.paneApi && input && observation) {
				recordFocusedInput(input, observation, durationMs);
			}
		},
		onCancel: abortFocusObservation,
		onCommit: () => {
			const observation = focusObservationRef.current;
			if (observation)
				workspacePerformance.markPaneFocusCommit(observation.sequence);
		},
	});

	return { focusPaneInput, recordInputFocusHandler };
}
