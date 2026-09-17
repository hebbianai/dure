// PaneChrome's designated store-wiring point (cluster wiring hook). Every
// global-store subscription the pane header needs lives here; the component
// consumes the returned values and keeps rendering only. Each selector stays
// its own useStore subscription so rerender semantics match the previous
// inline wiring exactly.
import { hmuxSessionMetadataKey } from "@/lib/hmux/identity/hmuxSessionMetadata";
import {
	getHmuxPaneHealth,
	useHmuxPaneHealthPresentation,
} from "@/lib/terminal/hmuxPaneHealthStore";
import {
	isHmuxPaneBinding,
	type TerminalPaneBindingV1,
} from "@/lib/terminal/terminalBinding";
import {
	type AgentPaneParameters,
	agentIdFromPane,
} from "@/lib/workspace/layout/agentPaneParameters";
import type { LocalHmuxPaneParameters } from "@/lib/workspace/pane/paneHmuxRehostAction";
import { useStore } from "@/store";
import type { Agent } from "@/types";

const CLOSED_PANE_MENU_AGENTS: readonly Agent[] = [];

export interface PaneParams extends LocalHmuxPaneParameters {
	agentRef?: AgentPaneParameters["agentRef"];
	agentId?: string;
	sessionId?: string;
	hostId?: string;
	cwd?: string;
	binding?: TerminalPaneBindingV1;
}

export function usePaneChromeState({
	params,
	panelId,
	component,
	desktopId,
	paneRuntimeId,
	pinKey,
	includeSwitchCandidates,
}: {
	params: PaneParams | undefined;
	panelId: string;
	component: string;
	desktopId: string | undefined;
	paneRuntimeId: string;
	pinKey: string;
	includeSwitchCandidates: boolean;
}) {
	const agentId = agentIdFromPane({ id: panelId, component, params });
	const agent = useStore((s) => s.agents.find((a) => a.id === agentId));
	const candidatePaneBinding = params?.binding;
	const paneBinding = isHmuxPaneBinding(candidatePaneBinding)
		? candidatePaneBinding
		: undefined;
	const candidateAgentBinding = agent?.runtimeBinding;
	const agentBinding = isHmuxPaneBinding(candidateAgentBinding)
		? candidateAgentBinding
		: undefined;
	const isAgentPane = component === "agent";
	const hmuxBinding = isAgentPane ? agentBinding : paneBinding;
	const sessionId =
		hmuxBinding?.sessionId ?? (isAgentPane ? undefined : params?.sessionId);
	// 파일 뷰어 pane(이미지·영상 포함)도 숨길 수 있다 — 세션이 없으므로 파일
	// 좌표를 기록해 두고 복원 시 다시 연다(hiddenFilePanesStore).
	const projects = useStore((s) => s.projects);
	const sshHosts = useStore((s) => s.sshHosts);
	const desktopKind = useStore((s) =>
		desktopId
			? s.spaces.find((desktop) => desktop.id === desktopId)?.kind
			: undefined,
	);
	const project = projects.find(
		(candidate) => candidate.id === agent?.projectId,
	);
	const gitError = useStore((s) =>
		agent ? s.gitStatusErrors[agent.id] : undefined,
	);
	const sshState = useStore((s) =>
		sessionId ? s.sshStates[sessionId] : undefined,
	);
	const liveCwd = useStore((s) =>
		sessionId ? s.sessionCwd[sessionId] : undefined,
	);
	const terminalTitle = useStore((s) =>
		sessionId ? s.sessionTitle[sessionId] : undefined,
	);
	const sessionProvider = useStore((s) =>
		sessionId
			? (s.sessionAgentPin[sessionId] ?? s.sessionAgent[sessionId] ?? null)
			: null,
	);
	const sessionAgentRuntimeState = useStore((s) =>
		sessionId ? s.sessionAgentRuntimeState[sessionId] : undefined,
	);
	const agentLiveCwd = useStore((s) =>
		agent ? s.sessionCwd[agent.sessionId] : undefined,
	);
	// A remote binding names the pane's Host; the top-level id only survives
	// for pre-binding SSH layouts. Without this a remote standalone shell under
	// a `term:` key has no host here and reads as local.
	const paneHostId =
		paneBinding?.source === "ssh" ? paneBinding.hostId : params?.hostId;
	const sshHost = useStore((s) =>
		s.sshHosts.find((host) => host.id === paneHostId),
	);
	const agentSshHost = useStore((s) =>
		s.sshHosts.find((host) => host.id === project?.sshHostId),
	);
	const hmuxSessionMetadata = useStore((s) =>
		hmuxBinding
			? s.hmuxSessionMetadata[
					hmuxSessionMetadataKey(hmuxBinding.workspaceId, hmuxBinding.sessionId)
				]
			: undefined,
	);
	const hmuxHealth = useHmuxPaneHealthPresentation(paneRuntimeId);
	const getHmuxHealthSnapshot = () => getHmuxPaneHealth(paneRuntimeId);
	const pinned = useStore((s) => s.pinnedPanes[pinKey] === true);
	const togglePanePin = useStore((s) => s.togglePanePin);
	const allAgents = useStore((s) =>
		includeSwitchCandidates ? s.agents : CLOSED_PANE_MENU_AGENTS,
	);
	return {
		agent,
		sessionId,
		hmuxBinding,
		projects,
		sshHosts,
		desktopKind,
		project,
		gitError,
		sshState,
		liveCwd,
		terminalTitle,
		sessionProvider,
		sessionAgentRuntimeState,
		agentLiveCwd,
		sshHost,
		agentSshHost,
		hmuxSessionMetadata,
		hmuxHealth,
		getHmuxHealthSnapshot,
		pinned,
		togglePanePin,
		allAgents,
	};
}
