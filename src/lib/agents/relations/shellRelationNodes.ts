// Plain shell rows as nodes of the relation forest. `dure run` started in a
// plain shell pane records that pane's Hmux Session as the Run's parent
// (cli/lib/run-parent.mjs), and the shell has no Agent record to name, so the
// relation owner names its row: the Space and the pane that hold the Session.
// The panes are the ones the Spaces list interprets (spacesPaneProjection),
// read from the saved layouts, so every reader of the forest sees the same
// shells. The module imports no React.
import type { AgentRunParentSessionV1 } from "@/lib/agents/agentRunParent";
import {
	createSpacesPaneProjection,
	type SpacePane,
} from "@/lib/spaces/spacesPaneProjection";
import type { AppState } from "@/store";

const SHELL_ROW_KEY_PREFIX = "pane:";

/** The key of a plain shell row in the relation forest and in every list
 * that shows the row. Pane ids are unique per Space only. */
export function shellRowKey(desktopId: string, panelId: string): string {
	return `${SHELL_ROW_KEY_PREFIX}${desktopId}:${panelId}`;
}

/** Whether a relation or list key names a plain shell row, not an Agent. */
export function isShellRowKey(key: string): boolean {
	return key.startsWith(SHELL_ROW_KEY_PREFIX);
}

/** A plain shell pane that holds an Hmux Session. */
export interface ShellRelationNode {
	/** `shellRowKey(desktopId, panelId)`. */
	readonly key: string;
	readonly desktopId: string;
	readonly panelId: string;
	/** The pane's terminal session in this client, which its runtime facts
	 * (provider, cwd) are keyed by. */
	readonly terminalSessionId: string;
	readonly cwd?: string;
	/** The Hmux Session it holds: the parent `dure run` records when it is
	 * started in this pane. */
	readonly session: AgentRunParentSessionV1;
}

/** The plain shell panes among `panes` that hold an Hmux Session, in order.
 * Several panes may hold one Session; each is its own node. */
export function shellRelationNodes(
	panes: readonly SpacePane[],
): ShellRelationNode[] {
	return panes.flatMap((pane) =>
		pane.kind === "agent" || !pane.hmuxIdentity
			? []
			: [
					{
						key: shellRowKey(pane.desktopId, pane.key),
						desktopId: pane.desktopId,
						panelId: pane.key,
						terminalSessionId: pane.sessionId,
						...(pane.cwd ? { cwd: pane.cwd } : {}),
						session: {
							sessionId: pane.hmuxIdentity.sessionId,
							workspaceId: pane.hmuxIdentity.workspaceId,
						},
					},
				],
	);
}

function sameNode(left: ShellRelationNode, right: ShellRelationNode): boolean {
	return (
		left.key === right.key &&
		left.terminalSessionId === right.terminalSessionId &&
		left.cwd === right.cwd &&
		left.session.sessionId === right.session.sessionId &&
		left.session.workspaceId === right.session.workspaceId
	);
}

const projectPanes = createSpacesPaneProjection();
let cache: {
	layouts?: AppState["layouts"];
	spaces?: AppState["spaces"];
	nodes: readonly ShellRelationNode[];
} = { nodes: [] };

/** The shell nodes of every Space's saved layout. The same nodes keep the
 * same array, so a selector of it changes only when a shell does. */
export function shellRelationNodesOf(
	state: Pick<AppState, "layouts" | "spaces">,
): readonly ShellRelationNode[] {
	if (cache.layouts === state.layouts && cache.spaces === state.spaces) {
		return cache.nodes;
	}
	const next = shellRelationNodes(
		projectPanes(
			state.layouts,
			"",
			state.spaces.map((space) => space.id),
			undefined,
		),
	);
	const nodes =
		next.length === cache.nodes.length &&
		next.every((node, index) => sameNode(node, cache.nodes[index]))
			? cache.nodes
			: next;
	cache = { layouts: state.layouts, spaces: state.spaces, nodes };
	return nodes;
}
