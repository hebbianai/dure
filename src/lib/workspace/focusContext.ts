import { sessionKindExecutionProfile } from "@/lib/terminal/sessionKindExecutionProfile";
import type { TerminalExecutionLocation } from "@/lib/terminal/terminalExecutionLocation";
import { agentIdFromPane } from "@/lib/workspace/layout/agentPaneParameters";
import type { SerializedPanelRef } from "@/lib/workspace/layout/layoutLifecycle";
import type { Agent, Project } from "@/types";

export interface FocusContext {
	key?: string;
	agentId?: string;
	cwd: string;
	source: "local" | "ssh";
	hostId?: string;
	label: string;
}

export function sameFocusContext(
	left: FocusContext | null,
	right: FocusContext | null,
): boolean {
	return (
		left === right ||
		(left !== null &&
			right !== null &&
			left.key === right.key &&
			left.agentId === right.agentId &&
			left.cwd === right.cwd &&
			left.source === right.source &&
			left.hostId === right.hostId &&
			left.label === right.label)
	);
}

/** Projects the current content's folder and target without interpreting its ID. */
export function focusContextForPane(
	pane: SerializedPanelRef | undefined,
	state: {
		agents: readonly Agent[];
		projects: readonly Project[];
		sessionCwd: Readonly<Record<string, string>>;
	},
	executionLocation: (sessionId: string) => TerminalExecutionLocation,
	terminalLabel: string,
): FocusContext | null {
	if (!pane) return null;
	const segment = (path: string) =>
		path.replace(/\/+$/, "").split("/").filter(Boolean).pop() || path;
	if (pane.component === "agent") {
		const agentId = agentIdFromPane(pane);
		const agent = state.agents.find((candidate) => candidate.id === agentId);
		if (!agent) return null;
		const project = state.projects.find(
			(candidate) => candidate.id === agent.projectId,
		);
		return {
			key: pane.id,
			agentId: agent.id,
			cwd: agent.worktreePath,
			source: sessionKindExecutionProfile(agent.sessionKind).transport,
			hostId: project?.sshHostId,
			label: segment(agent.worktreePath),
		};
	}
	const params = pane.params as {
		sessionId?: string;
		cwd?: string;
		hostId?: string;
	};
	// Keep a terminal's focus identity even when its working directory is unobserved.
	if (pane.component === "terminal") {
		const location = executionLocation(params.sessionId ?? "");
		if (location.kind === "ssh") {
			return { key: pane.id, cwd: "", source: "ssh", label: location.target };
		}
		const cwd = state.sessionCwd[params.sessionId ?? ""] || params.cwd || "";
		return {
			key: pane.id,
			cwd,
			source: "local",
			label: cwd ? segment(cwd) : terminalLabel,
		};
	}
	if (pane.component === "ssh") {
		const cwd = state.sessionCwd[params.sessionId ?? ""] || params.cwd || "";
		return {
			key: pane.id,
			cwd,
			source: "ssh",
			hostId: params.hostId,
			label: cwd ? segment(cwd) : "ssh",
		};
	}
	return null;
}
