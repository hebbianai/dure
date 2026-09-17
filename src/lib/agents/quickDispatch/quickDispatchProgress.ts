// Progress bus for in-flight quick dispatches. The pipeline publishes the
// stage it is working through; the always-mounted launcher subscribes and
// renders the live progress pill. Same window-CustomEvent idiom as
// src/lib/search/nativeSearchBus.ts — presentation-only signaling, never a
// second authority over the intent journal.

const PROGRESS_EVENT = "dure:quick-dispatch-progress";

export type QuickDispatchStage = "naming" | "spawning" | "done" | "failed";

export interface QuickDispatchProgress {
	intentId: string;
	stage: QuickDispatchStage;
}

const STAGES: readonly QuickDispatchStage[] = [
	"naming",
	"spawning",
	"done",
	"failed",
];

export function publishQuickDispatchProgress(
	progress: QuickDispatchProgress,
): void {
	window.dispatchEvent(
		new CustomEvent<QuickDispatchProgress>(PROGRESS_EVENT, {
			detail: progress,
		}),
	);
}

export function onQuickDispatchProgress(
	callback: (progress: QuickDispatchProgress) => void,
): () => void {
	const handler = (event: Event) => {
		const detail = (event as CustomEvent<Partial<QuickDispatchProgress>>)
			.detail;
		if (
			typeof detail?.intentId !== "string" ||
			!STAGES.includes(detail.stage as QuickDispatchStage)
		) {
			return;
		}
		callback({
			intentId: detail.intentId,
			stage: detail.stage as QuickDispatchStage,
		});
	};
	window.addEventListener(PROGRESS_EVENT, handler);
	return () => window.removeEventListener(PROGRESS_EVENT, handler);
}
