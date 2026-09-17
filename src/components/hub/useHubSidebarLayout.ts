/**
 * 사이드바 묶음을 허브에게 알려 주는 배선.
 *
 * 내용은 [`buildSidebarLayout`] 이 만들고, 여기는 무엇을 넘길지와 언제 보낼지만
 * 정한다.
 *
 * # 왜 앱 루트에 걸리나
 *
 * 사이드바 컴포넌트 안에 두면 사이드바를 접는 순간 갱신이 멈춘다. 그러면 접어 둔
 * 채로 세션을 옮긴 사람의 폰은 옛 묶음을 계속 보고, 그 화면은 폰이 낡은 것과
 * 구별되지 않는다. 이 훅은 화면에 아무것도 그리지 않으므로 언제나 살아 있는 곳에
 * 걸어 둔다.
 *
 * # 왜 값이 바뀔 때만 보내나
 *
 * store 는 자주 바뀐다 — 에이전트의 활동, 실행 위치, 열려 있는 pane 의 상태까지.
 * 그중 이 표를 바꾸는 것은 일부뿐이라, 매번 보내면 대부분이 같은 값을 다시 보내는
 * IPC 가 된다. 만든 표를 직전 것과 비교해서 다를 때만 보낸다.
 *
 * Live row presentation is included in the in-memory snapshot. The hub puts
 * it on catalog entries, separate from the durable placement projection, so
 * activity and Git changes do not rewrite the phone's layout cache.
 *
 * # The title is the sidebar's title
 *
 * A row's title on the phone is whatever the laptop puts in this table; the
 * phone has no conversation of its own to read one from. So the table has to
 * carry the same title the sidebar draws, and for an agent with no open pane
 * that is not `agent.name`: the name is the worktree slug (`codex-14`), which
 * on the phone read as a list of branches. The sidebar resolves the unopened
 * row's title from the provider's conversation history and the live session
 * title (`unopenedAgentRows`); this hook resolves it the same way, from the
 * same inputs, so the two screens name the same session the same thing.
 *
 * Titles change rarely — once when the conversation earns one — so carrying
 * them keeps to the change-only rule above.
 */

import { normalizeDiffBadge } from "@/lib/scm/status/diffBadges";
import { useAgentAttention } from "@/lib/agents/agentAttentionStore";
import { useDiffBadges } from "@/lib/scm/status/diffBadgesStore";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useRecentSessionHistory } from "@/components/sessions/useRecentSessionHistory";
import { useSpaces } from "@/components/spaces/useSpaces";
import { sessionPresentation } from "@/lib/hub/sessionPresentation";
import { presentedAgentDisplayState } from "@/lib/agents/agentStateModel";
import { buildSidebarLayout } from "@/lib/hub/sidebarLayout";
import { pathBasename } from "@/lib/files/paths";
import {
	conversationPresentationRevision,
	conversationTitle,
	conversationActivityAt,
	conversationPrompt,
	subscribeConversationPresentation,
} from "@/lib/agents/chat/conversationPresentationState";
import { managedConversationId } from "@/lib/sessions/managed/managedConversationIdentity";
import { agentRowActivityAt } from "@/lib/spaces/unopenedAgentPresentation";
import { paneHmuxSessionId } from "@/lib/spaces/hmuxSessionIdentity";
import { selectUnopenedAgents } from "@/lib/workspace/layout/agentPaneLocations";
import {
	indexUnopenedAgentConversations,
	resolveUnopenedAgentPresentation,
	unopenedAgentConversation,
} from "@/lib/spaces/unopenedAgentPresentation";
import { isMainWindow } from "@/lib/workspace/window/windows";
import { useStore } from "@/store";

/** 허브에게 표를 넘기는 쪽. 시험이 진짜 IPC 없이 이 훅을 태울 수 있게 주입한다. */
export type LayoutSink = (layout: ReturnType<typeof buildSidebarLayout>) => void;

export function useHubSidebarLayout(send: LayoutSink): void {
	const desktops = useStore((state) => state.desktops);
	const agents = useStore((state) => state.agents);
	const projects = useStore((state) => state.projects);
	const sshHosts = useStore((state) => state.sshHosts);
	const diffBadges = useDiffBadges(state => state.badges);
	const gitStatuses = useStore((state) => state.gitStatuses);
	const sessionTitle = useStore((state) => state.sessionTitle);
	const spaces = useSpaces();
	const sessionActivity = useStore((state) => state.sessionActivity);
	const displayStates = useAgentAttention((state) => state.displayStates);
	const activity = useStore((state) => state.agentActivity);
	// The same history the Spaces pane reads for its unopened rows, and the
	// same live-title revision counter `useSpaces` subscribes to.
	const history = useRecentSessionHistory(sshHosts);
	const conversationIndex = useMemo(
		() => indexUnopenedAgentConversations(history.entries),
		[history.entries],
	);
	const titleRevision = useSyncExternalStore(
		subscribeConversationPresentation,
		conversationPresentationRevision,
		conversationPresentationRevision,
	);

	/**
	 * 세션 하나의 브랜치.
	 *
	 * 살아 있는 폴링 값이 먼저다 — 사람이 방금 체크아웃했으면 그쪽이 맞다.
	 * 없으면 에이전트가 들고 있는 값으로 떨어진다. 둘 다 없으면 `undefined` 이고,
	 * 그러면 표에 키가 안 실린다.
	 */
	const branchOf = useMemo(() => {
		const byAgent = new Map<string, string | undefined>();
		// 워크트리 경로로도 찾는다. 터미널/SSH pane 은 `agentId` 가 아예 없어서
		// (`useSpaces` 의 분류가 에이전트 pane 에만 붙인다) 에이전트 색인으로는
		// 영원히 못 찾고, 폰에서는 그 줄만 브랜치가 비어 보인다 — 같은 워크트리에
		// 에이전트가 서 있어도.
		const byPath = new Map<string, string>();
		for (const agent of agents) {
			const branch = gitStatuses[agent.id]?.branch?.trim() || agent.branch?.trim() || undefined;
			byAgent.set(agent.id, branch);
			if (branch && agent.worktreePath) byPath.set(agent.worktreePath, branch);
		}
		return (agentId: string | undefined, cwd?: string): string | undefined =>
			(agentId === undefined ? undefined : byAgent.get(agentId)) ??
			(cwd === undefined ? undefined : byPath.get(cwd));
	}, [agents, gitStatuses]);
	const lastSent = useRef<string>("");

	const unopened = useMemo(() => {
		// 숨긴 pane 도 `spaces` 에 있으므로(원래 자리를 남긴다) 여기서 "열려 있다"
		// 로 세어진다. 사이드바가 같은 규칙을 쓴다 — 숨긴 에이전트는 데스크탑 그룹
		// 안에 이미 한 줄로 있고, 목록 아래에 또 나오면 안 된다.
		const open = new Set(
			spaces.flatMap((space) => (space.kind === "agent" && space.agentId ? [space.agentId] : [])),
		);
		return selectUnopenedAgents(agents, open).map((agent) => {
			const project = projects.find((candidate) => candidate.id === agent.projectId);
			return {
				hmuxSessionId: paneHmuxSessionId({ kind: "agent" }, agent),
				branch: branchOf(agent.id),
				projectName: project?.name ?? pathBasename(agent.worktreePath),
				title: resolveUnopenedAgentPresentation({
					agent,
					liveConversationTitle: conversationTitle(agent.id),
					liveSessionTitle: sessionTitle[agent.sessionId],
					conversation: unopenedAgentConversation(conversationIndex, agent, project),
				}).title,
				hostId: project?.sshHostId,
				presentation: sessionPresentation({
					kind: "agent", provider: agent.provider,
					projectId: project?.id, projectName: project?.name,
					cwd: agent.worktreePath, hostId: project?.sshHostId,
					hostLabel: sshHosts.find(host => host.id === project?.sshHostId)?.name,
					displayState: presentedAgentDisplayState(displayStates[agent.id], activity[agent.id]),
					activityAt: agentRowActivityAt(sessionActivity[agent.sessionId], conversationActivityAt(agent.id, managedConversationId(agent))),
					detail: sessionActivity[agent.sessionId]?.text || conversationPrompt(agent.id, managedConversationId(agent)),
				}, diffBadges[agent.id] ? normalizeDiffBadge(diffBadges[agent.id]) : undefined),
			};
		});
		// `titleRevision` is not read; it is what makes a newly published live
		// title re-run this and reach the phone.
	}, [agents, projects, spaces, branchOf, sessionTitle, conversationIndex, titleRevision, sshHosts, displayStates, activity, sessionActivity, diffBadges]);

	// 브랜치는 space 자체의 값이 아니라 그 space 가 붙어 있는 에이전트의 값이라,
	// 표를 만들기 직전에 얹는다.
	const placed = useMemo(
		() => spaces.map((space) => ({ ...space, branch: branchOf(space.agentId, space.cwd), presentation: sessionPresentation(space, space.agentId && diffBadges[space.agentId] ? normalizeDiffBadge(diffBadges[space.agentId]) : undefined) })),
		[spaces, branchOf, diffBadges],
	);

	useEffect(() => {
		// 메인 창만 민다. popout 데스크탑 창도 App 을 렌더하는데, 그 창에는
		// git 폴러가 없어서(App.tsx 가 메인에서만 켠다) 브랜치가 하나도 없는 표를
		// 만든다. 그 표가 마지막에 도착하면 허브의 배치표를 통째로 갈아 끼우고,
		// 메인 창은 자기 `lastSent` 가 그대로라 다시 밀지 않는다 — 폰의 브랜치는
		// 그 창을 닫을 때까지 안 돌아온다.
		if (!isMainWindow()) return;
		const layout = buildSidebarLayout(desktops, placed, unopened, sshHosts);
		const encoded = JSON.stringify(layout);
		if (encoded === lastSent.current) return;
		lastSent.current = encoded;
		send(layout);
	}, [desktops, placed, unopened, sshHosts, send]);
}
