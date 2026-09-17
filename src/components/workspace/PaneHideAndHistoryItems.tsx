// PaneChrome 공통 메뉴의 숨기기·최근 작업 actions — "최근 작업"의 실제
// 메뉴는 AgentPanel의 대화 기록 컨트롤이 소유하고 여기서는 신호로 연다.
import { conversationHistoryMenuAvailable } from "@/lib/agents/agentConversationHistory";
import type { FileTarget } from "@/lib/files/fileTarget";
import type { TerminalPaneBindingV1 } from "@/lib/terminal/terminalBinding";
import { hidePaneWithRecord } from "@/lib/workspace/pane/paneHideActions";
import { requestConversationHistoryMenu } from "@/lib/workspace/pane/paneMenuSignals";
import { useStore } from "@/store";
import type { Agent, Project } from "@/types";

export function usePaneHideAndHistoryActions({
	agent,
	binding,
	desktopId,
	panelId,
	file,
	projectKind,
}: {
	agent: Agent | undefined;
	binding: TerminalPaneBindingV1 | undefined;
	desktopId: string | undefined;
	panelId: string;
	file: FileTarget | undefined;
	projectKind: Project["kind"] | undefined;
}) {
	const agentActivity = useStore((s) =>
		agent ? (s.agentActivity[agent.id] ?? "connecting") : undefined,
	);
	const historyAvailable =
		!!agent &&
		!!agentActivity &&
		conversationHistoryMenuAvailable({
			activity: agentActivity,
			binding,
			interactionProfile: agent.interactionProfile,
			projectKind,
			provider: agent.provider,
		});
	return {
		hide:
			(agent || file) && desktopId
				? () =>
						hidePaneWithRecord({
							desktopId,
							panelId,
							...(agent ? { agentId: agent.id } : {}),
							...(file ? { file } : {}),
						})
				: undefined,
		history: historyAvailable
			? () => requestConversationHistoryMenu(panelId)
			: undefined,
	};
}
