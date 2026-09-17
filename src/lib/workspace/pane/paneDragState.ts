export interface PaneDragState {
	panelId: string;
	fromDesktopId: string;
}

let dragState: PaneDragState | null = null;

export function setDragState(state: PaneDragState | null): void {
	dragState = state;
}

export function getDragState(): PaneDragState | null {
	return dragState;
}
