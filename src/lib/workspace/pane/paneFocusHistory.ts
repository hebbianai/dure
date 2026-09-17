import type { DockviewApi } from "dockview-react";

export type PaneFocusHistoryDirection = "back" | "forward";

const MAX_HISTORY = 100;

/** Browser-style focus history for one mounted Dockview. */
export class PaneFocusHistory {
	private back: string[] = [];
	private current: string | undefined;
	private forward: string[] = [];

	visit(panelId: string | undefined): void {
		if (!panelId || panelId === this.current) return;
		if (this.current) this.push(this.back, this.current);
		this.current = panelId;
		this.forward = [];
	}

	move(
		direction: PaneFocusHistoryDirection,
		available: (panelId: string) => boolean,
	): string | undefined {
		const source = direction === "back" ? this.back : this.forward;
		const destination = direction === "back" ? this.forward : this.back;
		while (source.length > 0) {
			const target = source.pop();
			if (!target || target === this.current || !available(target)) continue;
			if (this.current) this.push(destination, this.current);
			this.current = target;
			return target;
		}
		return undefined;
	}

	private push(stack: string[], panelId: string): void {
		stack.push(panelId);
		if (stack.length > MAX_HISTORY) stack.splice(0, stack.length - MAX_HISTORY);
	}
}

const histories = new WeakMap<DockviewApi, PaneFocusHistory>();

function historyFor(api: DockviewApi): PaneFocusHistory {
	let history = histories.get(api);
	if (!history) {
		history = new PaneFocusHistory();
		histories.set(api, history);
	}
	return history;
}

/** Records an ordinary active-panel change in the Dockview-owned history. */
export function recordPaneFocus(
	api: DockviewApi,
	panelId: string | undefined,
): void {
	historyFor(api).visit(panelId);
}

/** Moves the history cursor without interpreting Dockview's spatial order. */
export function paneFromFocusHistory(
	api: DockviewApi,
	direction: PaneFocusHistoryDirection,
): string | undefined {
	return historyFor(api).move(direction, (panelId) => {
		const panel = api.getPanel(panelId);
		return Boolean(
			panel &&
				panel.group.api.location.type === "grid" &&
				panel.group.api.isVisible,
		);
	});
}
