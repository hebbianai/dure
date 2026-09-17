import {
	type Dispatch,
	type RefObject,
	type SetStateAction,
	useCallback,
	useRef,
	useState,
} from "react";
import {
	holdTerminalCanvasPresentation,
	type PaintedPresentation,
} from "./terminalCanvasPresentation";

export interface TerminalResizePresentationState {
	held: boolean;
	largeViewHeld: boolean;
	transactionGeneration?: number;
	requestGeneration?: number;
	finalGrid?: { columns: number; rows: number };
	appliedCanonicalColumns?: number;
	afterProjectionRevision?: bigint;
	appliedRecordId?: bigint;
}

interface TerminalResizePresentationOptions {
	readonly presentationLayerRef: RefObject<HTMLDivElement | null>;
	readonly paintedPresentationRef: RefObject<PaintedPresentation | null>;
}

interface TerminalResizePresentation {
	readonly presentationRef: RefObject<TerminalResizePresentationState>;
	readonly paintRevision: number;
	readonly setPaintRevision: Dispatch<SetStateAction<number>>;
	readonly hold: (transactionGeneration?: number) => void;
	readonly holdLargeView: () => void;
	readonly releaseLargeView: () => void;
	readonly request: (
		finalGrid: { columns: number; rows: number },
		requireHold: boolean,
		paintedPresentationIsCurrent: boolean,
	) => number;
	readonly applied: (
		requestGeneration: number,
		canonicalColumns: number,
		afterProjectionRevision: bigint,
		recordId: bigint,
	) => void;
	readonly complete: (requestGeneration: number) => void;
	readonly reset: () => void;
	readonly finish: () => void;
	readonly releaseFailed: (requestGeneration: number) => void;
}

export function useTerminalResizePresentation({
	presentationLayerRef,
	paintedPresentationRef,
}: TerminalResizePresentationOptions): TerminalResizePresentation {
	const [paintRevision, setPaintRevision] = useState(0);
	const presentationRef = useRef<TerminalResizePresentationState>({
		held: false,
		largeViewHeld: false,
	});
	const nextRequestGenerationRef = useRef(0);
	const hold = useCallback(
		(transactionGeneration?: number) => {
			const current = presentationRef.current;
			const paintedPresentation = paintedPresentationRef.current;
			if (!current.held && paintedPresentation === null) return;
			if (
				current.held &&
				(transactionGeneration === undefined ||
					current.transactionGeneration === transactionGeneration)
			) {
				return;
			}
			presentationRef.current = {
				...current,
				held: true,
				transactionGeneration,
			};
			const layer = presentationLayerRef.current;
			if (layer && paintedPresentation) {
				holdTerminalCanvasPresentation(layer, paintedPresentation);
			}
		},
		[presentationLayerRef, paintedPresentationRef],
	);
	const holdLargeView = useCallback(() => {
		const current = presentationRef.current;
		const paintedPresentation = paintedPresentationRef.current;
		if (current.largeViewHeld || paintedPresentation === null) return;
		presentationRef.current = { ...current, largeViewHeld: true };
		const layer = presentationLayerRef.current;
		if (layer) holdTerminalCanvasPresentation(layer, paintedPresentation);
	}, [presentationLayerRef, paintedPresentationRef]);
	const releaseLargeView = useCallback(() => {
		const current = presentationRef.current;
		if (!current.largeViewHeld) return;
		presentationRef.current = { ...current, largeViewHeld: false };
		setPaintRevision((revision) => revision + 1);
	}, []);
	const request = useCallback(
		(
			finalGrid: { columns: number; rows: number },
			requireHold: boolean,
			paintedPresentationIsCurrent: boolean,
		) => {
			const requestGeneration = ++nextRequestGenerationRef.current;
			const current = presentationRef.current;
			const paintedPresentation = paintedPresentationRef.current;
			const held =
				paintedPresentation !== null &&
				paintedPresentationIsCurrent &&
				(current.held || requireHold);
			presentationRef.current = {
				...current,
				held,
				requestGeneration,
				finalGrid,
				appliedCanonicalColumns: undefined,
				afterProjectionRevision: undefined,
				appliedRecordId: undefined,
			};
			const layer = presentationLayerRef.current;
			if (!current.held && held && layer && paintedPresentation) {
				holdTerminalCanvasPresentation(layer, paintedPresentation);
			}
			if (current.held !== held) {
				setPaintRevision((revision) => revision + 1);
			}
			return requestGeneration;
		},
		[presentationLayerRef, paintedPresentationRef],
	);
	const applied = useCallback(
		(
			requestGeneration: number,
			canonicalColumns: number,
			afterProjectionRevision: bigint,
			recordId: bigint,
		) => {
			const presentation = presentationRef.current;
			if (presentation.requestGeneration !== requestGeneration) return;
			presentationRef.current = {
				...presentation,
				appliedCanonicalColumns: canonicalColumns,
				afterProjectionRevision,
				appliedRecordId: recordId,
			};
			setPaintRevision((revision) => revision + 1);
		},
		[],
	);
	const complete = useCallback((requestGeneration: number) => {
		const presentation = presentationRef.current;
		if (presentation.requestGeneration !== requestGeneration) return;
		presentationRef.current = {
			held: false,
			largeViewHeld: presentation.largeViewHeld,
		};
	}, []);
	const reset = useCallback(() => {
		const presentation = presentationRef.current;
		presentationRef.current = {
			held: false,
			largeViewHeld: presentation.largeViewHeld,
		};
		setPaintRevision((revision) => revision + 1);
	}, []);
	const finish = useCallback(() => {
		const presentation = presentationRef.current;
		if (!presentation.held) return;
		if (presentation.requestGeneration === undefined) {
			presentationRef.current = {
				held: false,
				largeViewHeld: presentation.largeViewHeld,
			};
		}
		setPaintRevision((revision) => revision + 1);
	}, []);
	const releaseFailed = useCallback((requestGeneration: number) => {
		const presentation = presentationRef.current;
		if (presentation.requestGeneration !== requestGeneration) {
			return;
		}
		presentationRef.current = {
			held: false,
			largeViewHeld: presentation.largeViewHeld,
		};
		setPaintRevision((revision) => revision + 1);
	}, []);
	return {
		presentationRef,
		paintRevision,
		setPaintRevision,
		hold,
		holdLargeView,
		releaseLargeView,
		request,
		applied,
		complete,
		reset,
		finish,
		releaseFailed,
	};
}
