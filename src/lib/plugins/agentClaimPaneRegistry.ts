import { createBroadcast } from "@/lib/state/broadcast";
import { agentIdFromPane } from "@/lib/workspace/layout/agentPaneParameters";
import { panelsFromLayout } from "@/lib/workspace/layout/layoutLifecycle";
import type { HiddenPaneRecord } from "@/lib/workspace/pane/hiddenPanesStore";

export interface MountedAgentClaimPane {
	id: string;
	agentId: string;
}

interface MountedAgentClaimPaneEntry extends MountedAgentClaimPane {
	token: symbol;
}

interface AgentClaimPaneSources {
	layouts: Record<string, unknown>;
	spaces: readonly { id: string }[];
	agents: readonly { id: string }[];
	hidden: Readonly<
		Record<string, Pick<HiddenPaneRecord, "desktopId" | "paneId">>
	>;
}

export function agentClaimPanesFromLayouts(
	layouts: Record<string, unknown>,
	validDesktopIds?: ReadonlySet<string>,
): MountedAgentClaimPane[] {
	const panes = new Map<string, MountedAgentClaimPane>();
	for (const [desktopId, layout] of Object.entries(layouts)) {
		if (validDesktopIds && !validDesktopIds.has(desktopId)) continue;
		for (const panel of panelsFromLayout(layout)) {
			const id = panel.id;
			const agentId = agentIdFromPane(panel);
			if (agentId) panes.set(id, { id, agentId });
		}
	}
	return [...panes.values()].sort((left, right) =>
		left.id.localeCompare(right.id),
	);
}

/** Lightweight registry of persisted, mounted, and explicitly hidden agent
 * panes. Sources retain layout and Agent authority; this projection owns only
 * mounted handles and publishes when pane identity actually changes. */
export class AgentClaimPaneRegistry {
	private readonly changed = createBroadcast<void>();
	private readonly entries = new Map<string, MountedAgentClaimPaneEntry>();
	private snapshot: MountedAgentClaimPane[] = [];
	private source: AgentClaimPaneSources | null = null;
	private desktopIds = new Set<string>();
	private hiddenPanes: MountedAgentClaimPane[] = [];
	private layoutPanes: MountedAgentClaimPane[] = [];

	getSnapshot = (): readonly MountedAgentClaimPane[] => this.snapshot;

	subscribe(listener: () => void): () => void {
		return this.changed.subscribe(listener);
	}

	replaceSources(source: AgentClaimPaneSources): void {
		const previous = this.source;
		const spacesChanged = source.spaces !== previous?.spaces;
		const layoutsChanged =
			spacesChanged || source.layouts !== previous?.layouts;
		if (spacesChanged) {
			this.desktopIds = new Set(source.spaces.map((desktop) => desktop.id));
		}
		if (layoutsChanged) {
			this.layoutPanes = agentClaimPanesFromLayouts(
				source.layouts,
				this.desktopIds,
			);
		}
		let hiddenChanged = false;
		if (
			spacesChanged ||
			source.agents !== previous?.agents ||
			source.hidden !== previous?.hidden
		) {
			const agentIds = new Set(source.agents.map((agent) => agent.id));
			const hidden = Object.entries(source.hidden).flatMap(
				([agentId, record]) =>
					agentIds.has(agentId) && this.desktopIds.has(record.desktopId)
						? [{ id: record.paneId, agentId }]
						: [],
			);
			hiddenChanged =
				hidden.length !== this.hiddenPanes.length ||
				hidden.some(
					(pane, index) =>
						pane.id !== this.hiddenPanes[index].id ||
						pane.agentId !== this.hiddenPanes[index].agentId,
				);
			this.hiddenPanes = hidden;
		}
		this.source = source;
		if (layoutsChanged || hiddenChanged) this.publish();
	}

	mount(agentId: string, paneId: string): () => void {
		const token = Symbol(paneId);
		this.entries.set(paneId, { id: paneId, agentId, token });
		this.publish();
		return () => {
			if (this.entries.get(paneId)?.token !== token) return;
			this.entries.delete(paneId);
			this.publish();
		};
	}

	private publish(): void {
		const paneById = new Map(this.layoutPanes.map((pane) => [pane.id, pane]));
		for (const { id, agentId } of this.entries.values())
			paneById.set(id, { id, agentId });
		const panes = [...paneById.values()];
		const represented = new Set(panes.map((pane) => pane.agentId));
		for (const pane of this.hiddenPanes) {
			if (!represented.has(pane.agentId)) panes.push(pane);
		}
		panes.sort((left, right) => left.id.localeCompare(right.id));
		if (
			panes.length === this.snapshot.length &&
			panes.every(
				(pane, index) =>
					pane.id === this.snapshot[index].id &&
					pane.agentId === this.snapshot[index].agentId,
			)
		)
			return;
		this.snapshot = panes;
		this.changed.publish();
	}
}
