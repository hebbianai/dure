// 분할 대상 결정(스토어 읽기, dock 비의존) — 탭 헤더·우클릭·단축키·CLI 영수증이
// 같은 결정을 공유한다. 여는 동작(dock 의존)은 paneSplit.ts 소관.

import { bindingForAgent } from "@/lib/terminal/terminalBinding";
import { agentIdFromPane } from "@/lib/workspace/layout/agentPaneParameters";
import {
	type PaneSplitPaneParams,
	type PaneSplitTarget,
	resolvePaneSplitTarget,
} from "@/lib/workspace/pane/paneSplitTarget";
import { useStore } from "@/store";

/** Current content owns the inherited location. Historical pane spelling and
 * copied Agent fields cannot redirect a terminal or a launcher to another task. */
export function paneSplitTargetForPanel(
	pane: { id: string; component?: string },
	params?: PaneSplitPaneParams,
): PaneSplitTarget {
	const state = useStore.getState();
	const agentPane = pane.component === "agent";
	const agentId = agentPane
		? agentIdFromPane({ ...pane, params })
		: pane.component === "diff"
			? params?.agentId
			: undefined;
	const agent = state.agents.find((candidate) => candidate.id === agentId);
	const sessionId =
		agent?.sessionId ??
		(agentPane ? undefined : (params?.binding?.sessionId ?? params?.sessionId));
	const binding = agent
		? bindingForAgent(agent, state.projects)
		: agentPane
			? undefined
			: params?.binding;
	return resolvePaneSplitTarget({
		binding,
		paneHostId: agentPane ? undefined : params?.hostId,
		projectSshHostId: state.projects.find(
			(project) => project.id === agent?.projectId,
		)?.sshHostId,
		liveCwd: sessionId ? state.sessionCwd[sessionId] : undefined,
		paneCwd: agentPane ? undefined : params?.cwd,
		worktreePath: agent?.worktreePath,
	});
}
