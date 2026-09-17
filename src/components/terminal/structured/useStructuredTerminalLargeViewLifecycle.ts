import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useWorkspaceRuntimeDesktopId } from "@/components/workspace/WorkspaceRuntimeContext";
import type { TerminalDocumentResizeSurfaceRegistration } from "@/lib/terminal/geometry/terminalDocumentResizeTransaction";
import type { InstalledTerminalViewportFrame } from "@/lib/terminal/state/structuredTerminalViewport";
import {
	currentWindowIsFocused,
	subscribeCurrentWindowFocus,
} from "@/lib/workspace/window/currentWindowFocus";
import { bindLargeViewReturnSource } from "@/lib/workspace/window/largeViewReturnSourceRuntime";

interface CurrentRef<T> {
	readonly current: T;
}

interface MutableCurrentRef<T> {
	current: T;
}

interface StructuredTerminalGeometry {
	readonly columns: number;
	readonly rows: number;
}

interface StructuredTerminalLargeViewLifecycleOptions {
	readonly workspaceId?: string;
	readonly sessionId: string;
	readonly surfaceId: string;
	readonly containerRef: CurrentRef<HTMLDivElement | null>;
	readonly geometryRef: CurrentRef<StructuredTerminalGeometry>;
	readonly attachedObserverRef: CurrentRef<string | undefined>;
	readonly attachedGeometryPendingRef: MutableCurrentRef<string | undefined>;
	readonly resizeRegistrationRef: CurrentRef<
		TerminalDocumentResizeSurfaceRegistration | undefined
	>;
	readonly attachmentId?: string;
	readonly terminalEpoch: string | null;
	readonly stateRevision: bigint;
	readonly installedFrame?: InstalledTerminalViewportFrame | null;
	readonly onGeometryObserved?: () => void;
	readonly onReturnPrepared?: () => void;
	readonly requestReturnRetirementFence: (rows: number) => bigint | undefined;
	readonly holdPresentation: () => void;
	readonly releasePresentation: () => void;
}

interface ReturnTarget extends StructuredTerminalGeometry {
	readonly generation: string;
	readonly attachmentId: string;
	readonly terminalEpoch: string;
	readonly stateRevision: bigint;
	readonly afterProjectionRevision: bigint;
	readonly retirementIntentSeq?: bigint;
}

/**
 * Keeps the exact source's last complete projection visible until it is the
 * native key window and has a Host-confirmed post-retirement current frame
 * aligned to its local rows. The source registration stays stable while an
 * active generation retargets only when its attachment, epoch, or local grid
 * changes.
 */
export function useStructuredTerminalLargeViewLifecycle({
	workspaceId,
	sessionId,
	surfaceId,
	containerRef,
	geometryRef,
	attachedObserverRef,
	attachedGeometryPendingRef,
	resizeRegistrationRef,
	attachmentId,
	terminalEpoch,
	stateRevision,
	installedFrame,
	onGeometryObserved,
	onReturnPrepared,
	requestReturnRetirementFence,
	holdPresentation,
	releasePresentation,
}: StructuredTerminalLargeViewLifecycleOptions): () => void {
	const desktopId = useWorkspaceRuntimeDesktopId();
	const frameRef = useRef(installedFrame);
	frameRef.current = installedFrame;
	const attachmentIdRef = useRef(attachmentId);
	attachmentIdRef.current = attachmentId;
	const terminalEpochRef = useRef(terminalEpoch);
	terminalEpochRef.current = terminalEpoch;
	const stateRevisionRef = useRef(stateRevision);
	stateRevisionRef.current = stateRevision;
	const sourceRef = useRef<
		ReturnType<typeof bindLargeViewReturnSource> | undefined
	>(undefined);
	const targetRef = useRef<ReturnTarget | undefined>(undefined);
	const retiredGenerationRef = useRef<string | undefined>(undefined);
	const currentReturnTarget = useCallback(
		(generation: string): ReturnTarget | undefined => {
			const currentAttachmentId = attachmentIdRef.current;
			const currentTerminalEpoch = terminalEpochRef.current;
			const geometry = geometryRef.current;
			const frame = frameRef.current;
			if (
				!currentAttachmentId ||
				!currentTerminalEpoch ||
				attachedObserverRef.current !== currentAttachmentId ||
				!frame ||
				geometry.columns <= 0 ||
				geometry.rows <= 0
			) {
				return undefined;
			}
			return {
				generation,
				attachmentId: currentAttachmentId,
				terminalEpoch: currentTerminalEpoch,
				stateRevision: stateRevisionRef.current,
				columns: geometry.columns,
				rows: geometry.rows,
				afterProjectionRevision: frame.frame.projectionRevision,
			};
		},
		[attachedObserverRef, geometryRef],
	);
	const armRetirementFence = useCallback(
		(target: ReturnTarget): ReturnTarget => {
			if (
				retiredGenerationRef.current !== target.generation ||
				target.retirementIntentSeq !== undefined
			) {
				return target;
			}
			const retirementIntentSeq = requestReturnRetirementFence(target.rows);
			return retirementIntentSeq === undefined
				? target
				: { ...target, retirementIntentSeq };
		},
		[requestReturnRetirementFence],
	);
	const syncActiveReturnTarget = useCallback(() => {
		const target = targetRef.current;
		if (!target) return;
		const generation = sourceRef.current?.currentGeneration();
		if (!generation || generation !== target.generation) return;
		const next = currentReturnTarget(generation);
		if (
			!next ||
			(next.attachmentId === target.attachmentId &&
				next.terminalEpoch === target.terminalEpoch &&
				next.columns === target.columns &&
				next.rows === target.rows)
		) {
			return;
		}
		targetRef.current = armRetirementFence(next);
	}, [armRetirementFence, currentReturnTarget]);
	const retireLargeSurface = useCallback(
		(generation: string) => {
			if (sourceRef.current?.currentGeneration() !== generation) return;
			retiredGenerationRef.current = generation;
			syncActiveReturnTarget();
			const target = targetRef.current;
			if (target?.generation === generation) {
				targetRef.current = armRetirementFence(target);
			}
		},
		[armRetirementFence, syncActiveReturnTarget],
	);
	const geometryObservedAttachmentRef = useRef<string | undefined>(undefined);
	const completeIfReadyRef = useRef<() => void>(() => {});
	completeIfReadyRef.current = () => {
		const target = targetRef.current;
		const frame = frameRef.current;
		if (
			!target ||
			!frame ||
			!currentWindowIsFocused() ||
			attachmentIdRef.current !== target.attachmentId ||
			attachedObserverRef.current !== target.attachmentId ||
			terminalEpochRef.current !== target.terminalEpoch ||
			stateRevisionRef.current < target.stateRevision ||
			frame.frame.projectionRevision <= target.afterProjectionRevision ||
			target.retirementIntentSeq === undefined ||
			frame.frame.appliedIntentSeq < target.retirementIntentSeq ||
			frame.frame.canonicalColumns < target.columns ||
			frame.frame.viewportRows !== target.rows
		) {
			return;
		}
		sourceRef.current?.complete(target.generation);
	};

	useEffect(() => {
		if (!desktopId || !workspaceId) return;
		const host = containerRef.current;
		if (!host) return;
		const source = bindLargeViewReturnSource({
			workspaceId,
			sessionId,
			sourcePaneOwnerId: `${desktopId}:${surfaceId}`,
			legacyEligible: () =>
				currentWindowIsFocused() &&
				host.isConnected &&
				geometryRef.current.columns > 0 &&
				geometryRef.current.rows > 0,
			prepare: (generation) => {
				const target = currentReturnTarget(generation);
				if (!target) return false;
				retiredGenerationRef.current = undefined;
				targetRef.current = target;
				onReturnPrepared?.();
				return true;
			},
			retired: retireLargeSurface,
			conceal: holdPresentation,
			reveal: () => {
				targetRef.current = undefined;
				retiredGenerationRef.current = undefined;
				releasePresentation();
			},
		});
		sourceRef.current = source;
		const stopFocus = subscribeCurrentWindowFocus((focused) => {
			if (focused) completeIfReadyRef.current();
		});
		return () => {
			stopFocus();
			if (sourceRef.current === source) sourceRef.current = undefined;
			source.dispose();
			targetRef.current = undefined;
			retiredGenerationRef.current = undefined;
		};
	}, [
		containerRef,
		currentReturnTarget,
		desktopId,
		geometryRef,
		holdPresentation,
		onReturnPrepared,
		releasePresentation,
		retireLargeSurface,
		sessionId,
		surfaceId,
		workspaceId,
	]);

	useLayoutEffect(() => {
		const attachedObserver = attachedObserverRef.current;
		if (
			!installedFrame ||
			attachedObserver === undefined ||
			attachmentId !== attachedObserver ||
			terminalEpoch === null
		) {
			syncActiveReturnTarget();
			return;
		}
		if (attachedGeometryPendingRef.current === attachedObserver) {
			const registration = resizeRegistrationRef.current;
			const observation = registration?.noteGeometryChanged();
			if (registration && observation) {
				void registration.commitOrdinary(observation).then((committed) => {
					if (
						committed &&
						attachedGeometryPendingRef.current === attachedObserver
					) {
						attachedGeometryPendingRef.current = undefined;
					}
				});
			}
		}
		if (geometryObservedAttachmentRef.current !== attachedObserver) {
			geometryObservedAttachmentRef.current = attachedObserver;
			onGeometryObserved?.();
		}
		syncActiveReturnTarget();
		completeIfReadyRef.current();
	}, [
		attachedGeometryPendingRef,
		attachedObserverRef,
		attachmentId,
		installedFrame,
		onGeometryObserved,
		resizeRegistrationRef,
		syncActiveReturnTarget,
		terminalEpoch,
	]);
	return syncActiveReturnTarget;
}
