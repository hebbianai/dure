export type TerminalPresentationRole =
	| "foreground"
	| "hovered"
	| "background"
	| "ungated";

/** Projects one Workspace's selected and hovered terminals without owning work. */
export class TerminalPresentationRoleStore {
	private active = false;
	private foregroundPanelId: string | null | undefined;
	private hoveredPanelId: string | undefined;
	private readonly listeners = new Map<string, Set<() => void>>();

	configure(input: {
		active: boolean;
		foregroundPanelId: string | null | undefined;
	}) {
		const affectedPanelIds = new Set(
			[
				this.foregroundPanelId,
				input.foregroundPanelId,
				this.hoveredPanelId,
			].filter((panelId): panelId is string => typeof panelId === "string"),
		);
		const previousRoles = new Map(
			Array.from(affectedPanelIds, (panelId) => [panelId, this.role(panelId)]),
		);
		this.active = input.active;
		this.foregroundPanelId = input.foregroundPanelId;
		this.notifyRoleChanges(previousRoles);
	}

	role(panelId: string | undefined): TerminalPresentationRole {
		if (!panelId) return "ungated";
		if (!this.active) return "background";
		if (this.foregroundPanelId === panelId) return "foreground";
		if (this.hoveredPanelId === panelId) return "hovered";
		return "background";
	}

	setHovered(panelId: string, hovered: boolean) {
		const nextHoveredPanelId = hovered
			? panelId
			: this.hoveredPanelId === panelId
				? undefined
				: this.hoveredPanelId;
		if (nextHoveredPanelId === this.hoveredPanelId) return;
		const affectedPanelIds = new Set(
			[this.hoveredPanelId, nextHoveredPanelId].filter(
				(candidate): candidate is string => candidate !== undefined,
			),
		);
		const previousRoles = new Map(
			Array.from(affectedPanelIds, (candidate) => [
				candidate,
				this.role(candidate),
			]),
		);
		this.hoveredPanelId = nextHoveredPanelId;
		this.notifyRoleChanges(previousRoles);
	}

	subscribeRole(panelId: string, listener: () => void) {
		const listeners = this.listeners.get(panelId) ?? new Set<() => void>();
		listeners.add(listener);
		this.listeners.set(panelId, listeners);
		return () => {
			listeners.delete(listener);
			if (listeners.size === 0) this.listeners.delete(panelId);
		};
	}

	private notifyRoleChanges(
		previousRoles: ReadonlyMap<string, TerminalPresentationRole>,
	) {
		for (const [panelId, previousRole] of previousRoles) {
			if (previousRole === this.role(panelId)) continue;
			for (const listener of this.listeners.get(panelId) ?? []) listener();
		}
	}
}

export function isTerminalPresentationPanel(panel: {
	api: { component: string };
}) {
	return (
		panel.api.component === "agent" ||
		panel.api.component === "terminal" ||
		panel.api.component === "ssh"
	);
}

function visibleTerminalPresentationPanelIds(
	panels: readonly {
		id: string;
		api: { component: string; isVisible: boolean };
	}[],
) {
	return panels
		.filter(
			(panel) => panel.api.isVisible && isTerminalPresentationPanel(panel),
		)
		.map((panel) => panel.id);
}

export function terminalPresentationSetReady(
	panels: readonly {
		id: string;
		api: { component: string; isVisible: boolean };
	}[],
	hasExpectedPresentations: (panelIds: readonly string[]) => boolean,
	deadlineReached: boolean,
) {
	return (
		hasExpectedPresentations(visibleTerminalPresentationPanelIds(panels)) ||
		deadlineReached
	);
}
