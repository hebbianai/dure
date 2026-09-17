import type { DockviewApi } from "dockview-react";

export type PaneMoveLayoutSnapshot = ReturnType<DockviewApi["toJSON"]>;

const UNDO_CAP = 10;
const undoStacks = new WeakMap<DockviewApi, PaneMoveLayoutSnapshot[]>();

export function installPaneMoveUndoStack(api: DockviewApi): void {
	undoStacks.set(api, []);
}

export function removePaneMoveUndoStack(api: DockviewApi): void {
	undoStacks.delete(api);
}

/** Dockview 내부·Spaces 외부에서 시작한 이동이 공유하는 ⌘Z 기록. */
export function recordPaneMoveSnapshot(
	api: DockviewApi,
	snapshot: PaneMoveLayoutSnapshot,
): void {
	const stack = undoStacks.get(api);
	if (!stack) return;
	stack.push(snapshot);
	if (stack.length > UNDO_CAP) stack.shift();
}

export function undoPaneMove(api: DockviewApi | undefined): boolean {
	if (!api) return false;
	const snapshot = undoStacks.get(api)?.pop();
	if (!snapshot) return false;
	api.fromJSON(snapshot);
	return true;
}
