// Interaction signals feed one renderer-local foreground budget. Terminal and
// Structured Chat inputs report from their existing semantic boundaries, while
// workspacePerformance reports transition lifecycle. Frame-budget work and
// xterm parser admission share this deadline instead of owning pause clocks.
import { getForegroundInteractionBudget } from "./foregroundInteractionBudget";

/** 키 반복 등 고빈도 입력에서 notify 비용을 상수화한다. */
const INPUT_NOTIFY_THROTTLE_MS = 50;

export function createInputInteractionNotifier(
	notify: () => void,
	now: () => number = () => performance.now(),
): () => void {
	let lastNotifyMs = Number.NEGATIVE_INFINITY;
	return () => {
		const nowMs = now();
		if (nowMs - lastNotifyMs < INPUT_NOTIFY_THROTTLE_MS) return;
		lastNotifyMs = nowMs;
		notify();
	};
}

export const noteUserInput = createInputInteractionNotifier(() =>
	getForegroundInteractionBudget().note("input"),
);

export function noteDesktopSwitchStart(): void {
	getForegroundInteractionBudget().note("desktop-switch-start");
}

export function noteDesktopSwitchSettled(): void {
	getForegroundInteractionBudget().note("desktop-switch-settled");
}
