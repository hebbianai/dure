/**
 * Separates an existing-pane focus handoff from the first activation caused by
 * adding a pane. Dockview reports both through onDidActivePanelChange, but the
 * latter measures pane construction rather than focus latency.
 */
export class WorkspacePaneFocusIntent {
	private readonly knownPanelIds: Set<string>;
	private readonly pendingOpenActivations = new Set<string>();
	private activePanelId: string | undefined;

	constructor(initialPanelIds: Iterable<string> = [], activePanelId?: string) {
		this.knownPanelIds = new Set(initialPanelIds);
		this.activePanelId = activePanelId;
	}

	noteAdded(panelId: string): void {
		if (this.knownPanelIds.has(panelId)) return;
		this.knownPanelIds.add(panelId);
		this.pendingOpenActivations.add(panelId);
	}

	shouldMeasure(panelId: string): boolean {
		if (this.activePanelId === panelId) return false;
		this.activePanelId = panelId;
		// Stay correct if a Dockview release ever changes add/activate event order.
		if (!this.knownPanelIds.has(panelId)) {
			this.knownPanelIds.add(panelId);
			return false;
		}
		if (this.pendingOpenActivations.delete(panelId)) return false;
		return true;
	}

	noteRemoved(panelId: string): void {
		this.knownPanelIds.delete(panelId);
		this.pendingOpenActivations.delete(panelId);
		if (this.activePanelId === panelId) this.activePanelId = undefined;
	}
}
