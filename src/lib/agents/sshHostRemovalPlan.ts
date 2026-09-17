import { agentReferencesHost } from "@/lib/agents/agentHostReferences";
import {
	captureSshHostRemovalScope,
	type SshHostRemovalScopeSnapshot,
} from "@/lib/agents/sshHostRemovalScope";
import { classifyTerminalPaneHost } from "@/lib/terminal/paneHostIdentity";
import { desktopLayoutSnapshot } from "@/lib/workspace/desktop/desktopLifecycle";
import {
	type TerminalSessionRef,
	terminalSessionsFromLayout,
} from "@/lib/workspace/layout/terminalSessionRefs";
import { panelsFromLayout } from "@/lib/workspace/layout/layoutLifecycle";
import { useStore } from "@/store";
import type { Agent } from "@/types";

export interface SshHostRemovalPlan {
	hostId: string;
	scope: SshHostRemovalScopeSnapshot;
	projectIds: readonly string[];
	agents: readonly Agent[];
	panes: readonly {
		readonly spaceId: string;
		readonly panelId: string;
		readonly params: Readonly<Record<string, unknown>>;
		readonly sessions: readonly TerminalSessionRef[];
	}[];
}

/** Number of distinct runtime sessions covered by one Host-removal consent. */
export function sshHostRemovalSessionCount(plan: SshHostRemovalPlan): number {
	return new Set([
		...plan.agents.map((agent) => `${agent.sessionKind}\0${agent.sessionId}`),
		...plan.panes.flatMap((pane) =>
			pane.sessions.map((session) => `${session.kind}\0${session.sessionId}`),
		),
	]).size;
}

export function captureSshHostRemovalLayouts(): readonly {
	readonly spaceId: string;
	readonly layout: unknown;
}[] {
	const state = useStore.getState();
	const spaceIds = new Set([
		...state.spaces.map((space) => space.id),
		...Object.keys(state.layouts),
	]);
	return [...spaceIds].map((spaceId) => ({
		spaceId,
		layout: desktopLayoutSnapshot(spaceId),
	}));
}

export function planSshHostRemoval(hostId: string): SshHostRemovalPlan {
	const state = useStore.getState();
	const scope = captureSshHostRemovalScope(hostId, state);
	const projects = state.projects.filter(
		(project) => project.sshHostId === hostId,
	);
	const projectIds = new Set(projects.map((project) => project.id));
	const agents = state.agents.filter(
		(agent) =>
			projectIds.has(agent.projectId) || agentReferencesHost(agent, hostId),
	);
	const panes: SshHostRemovalPlan["panes"][number][] = [];

	for (const { spaceId, layout } of captureSshHostRemovalLayouts()) {
		for (const panel of panelsFromLayout(layout)) {
			if (classifyTerminalPaneHost(panel.params, hostId) !== "owned") continue;
			panes.push({
				spaceId,
				panelId: panel.id,
				params: structuredClone(panel.params),
				sessions: terminalSessionsFromLayout({
					panels: { [panel.id]: { params: panel.params } },
				}),
			});
		}
	}

	return {
		hostId,
		scope,
		projectIds: [...projectIds],
		agents,
		panes,
	};
}
