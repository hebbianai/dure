import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { useInterfaceMode } from "@/components/workspace/useInterfaceMode";
import {
	isAgentUnread,
	useAgentAttention,
} from "@/lib/agents/agentAttentionStore";
import { normalizeAgentDisplayName } from "@/lib/agents/agentDisplayName";
import { presentedAgentDisplayState } from "@/lib/agents/agentStateModel";
import {
	conversationActivityAt,
	conversationPresentationRevision,
	conversationPrompt,
	conversationTitle,
	subscribeConversationPresentation,
} from "@/lib/agents/chat/conversationPresentationState";
import { pathBasename } from "@/lib/files/paths";
import { hmuxManagedPromotionAvailability } from "@/lib/hmux/conversion/hmuxManagedPromotionEligibility";
import { hmuxSessionMetadataKey } from "@/lib/hmux/identity/hmuxSessionMetadata";
import { t } from "@/lib/i18n";
import { managedConversationId } from "@/lib/sessions/managed/managedConversationIdentity";
import { sessionRuntimeDisplayState } from "@/lib/sessions/runtime/sessionRuntimeDisplayState";
import { paneHmuxSessionId } from "@/lib/spaces/hmuxSessionIdentity";
import { projectIndexFor } from "@/lib/spaces/projectIndex";
import { spaceRowDetail } from "@/lib/spaces/spaceRowDetail";
import {
	createSpacesPaneProjection,
	type SpacePane as Space,
} from "@/lib/spaces/spacesPaneProjection";
import {
	createSpacesAttentionSelector,
	createSpacesRuntimeSelector,
} from "@/lib/spaces/spacesRuntimeProjection";
import { createSpacesSessionMetadataSelector } from "@/lib/spaces/spacesSessionMetadata";
import { agentRowActivityAt } from "@/lib/spaces/unopenedAgentPresentation";
import {
	getTerminalExecutionLocation,
	getTerminalExecutionLocationRevision,
	hasTerminalExecutionLocationObservation,
	subscribeTerminalExecutionLocations,
} from "@/lib/terminal/terminalExecutionLocationStore";
import { reuseStableRows } from "@/lib/ui/stableRows";
import { dockPanelReference } from "@/lib/workspace/dock/dockPanelParameters";
import { getDockview } from "@/lib/workspace/dock/dockRegistry";
import { subscribeDockviewRegistration } from "@/lib/workspace/dock/dockviewRegistration";
import { useHiddenPanes } from "@/lib/workspace/pane/hiddenPanesStore";
import {
	observedTitle,
	resolveAgentPaneTitle,
} from "@/lib/workspace/pane/paneTitle";
import { excludeHiddenAgentPanes } from "@/lib/workspace/pane/paneVisibility";
import { useStore } from "@/store";
import { PROVIDERS, type Provider } from "@/types";

const spaceBasename = (path: string) => pathBasename(path);

const REMOTE_SESSION_KINDS = new Set(["ssh"]);

/** 열려 있는 패널을 데스크탑·프로젝트·에이전트 정보와 합쳐 한 줄짜리 스페이스로
 *  펼친다. 스페이스 목록의 표현이 갈라져도 이 파생은 하나만 유지한다. */
/** Pinned repositories lead the repository-first list — the one place the
 *  Location Manager's pin shows outside the dialog (2026-09-03). */
export function usePinnedProjectIds(): readonly string[] {
	return useStore((state) => state.pinnedProjects);
}

export function useSpaces() {
	// 기본 모드 간소화(2026-08-31): managed 승격은 pro 표면 — 프로젝션에서
	// hidden으로 강등해 행 방패·메뉴 항목이 한 권위로 함께 접힌다.
	const interfaceMode = useInterfaceMode();
	const executionLocationRevision = useSyncExternalStore(
		subscribeTerminalExecutionLocations,
		getTerminalExecutionLocationRevision,
		getTerminalExecutionLocationRevision,
	);
	const titleRevision = useSyncExternalStore(
		subscribeConversationPresentation,
		conversationPresentationRevision,
		conversationPresentationRevision,
	);
	const agents = useStore((state) => state.agents);
	const spaces = useStore((state) => state.spaces);
	const projects = useStore((state) => state.projects);
	const sshHosts = useStore((state) => state.sshHosts);
	const { hostBuildByMetadataKey, sessionNameByMetadataKey } = useStore(
		useMemo(createSpacesSessionMetadataSelector, []),
	);

	const agentById = useMemo(
		() => new Map(agents.map((agent) => [agent.id, agent])),
		[agents],
	);
	const desktopOrder = useMemo(
		() => spaces.map((desktop) => desktop.id),
		[spaces],
	);

	const hiddenPanes = useHiddenPanes((state) => state.hidden);
	const projectPanes = useMemo(createSpacesPaneProjection, []);
	const activeSpaceId = useStore((state) => state.activeSpaceId);
	const readPanes = useCallback(() => {
		const state = useStore.getState();
		return projectPanes(
			state.layouts,
			activeSpaceId,
			desktopOrder,
			getDockview(activeSpaceId)?.panels.map((panel) => ({
				...dockPanelReference(panel),
				isVisible: panel.api.isVisible,
			})),
		);
	}, [activeSpaceId, desktopOrder, projectPanes]);
	// A move commits the durable layouts before projecting into Dockview. Observe
	// the subsequent Dockview publication too: a Zustand selector cannot observe
	// mutable live pane objects without another store update.
	const subscribePanes = useCallback(
		(listener: () => void) => {
			let layout: { dispose(): void } | undefined;
			const attach = () => {
				layout?.dispose();
				layout = getDockview(activeSpaceId)?.onDidLayoutChange(listener);
				listener();
			};
			const stopStore = useStore.subscribe(listener);
			const stopRegistration = subscribeDockviewRegistration((id) => {
				if (id === activeSpaceId) attach();
			});
			attach();
			return () => {
				stopStore();
				stopRegistration();
				layout?.dispose();
			};
		},
		[activeSpaceId],
	);
	const openPanes = useSyncExternalStore(subscribePanes, readPanes, readPanes);

	// All row runtime and watcher facts use the same open/hidden pane identity
	// walk. Rebinding refreshes the scope before reading current store values.
	const { sessionIds, agentIds } = useMemo(() => {
		const ids = new Set<string>();
		const agentsWithRows = new Set<string>();
		for (const space of openPanes) {
			if (space.agentId && agentById.has(space.agentId))
				agentsWithRows.add(space.agentId);
			const sessionId =
				space.kind === "agent"
					? space.agentId
						? agentById.get(space.agentId)?.sessionId
						: undefined
					: space.sessionId;
			if (sessionId) ids.add(sessionId);
		}
		for (const agentId of Object.keys(hiddenPanes)) {
			if (agentById.has(agentId)) agentsWithRows.add(agentId);
			const sessionId = agentById.get(agentId)?.sessionId;
			if (sessionId) ids.add(sessionId);
		}
		return {
			sessionIds: [...ids].sort(),
			agentIds: [...agentsWithRows].sort(),
		};
	}, [openPanes, hiddenPanes, agentById]);
	const {
		agentActivity: activity,
		sessionAgentRuntimeState,
		sessionCwd,
		sessionTitle,
		sessionAgent,
		sessionAgentPin,
		sessionActivity,
	} = useStore(
		useMemo(
			() => createSpacesRuntimeSelector(sessionIds, agentIds),
			[sessionIds, agentIds],
		),
	);
	// The watcher owns display state and unread episodes; only project its facts.
	const { displayStates, episodes, acks } = useAgentAttention(
		useMemo(() => createSpacesAttentionSelector(agentIds), [agentIds]),
	);

	const rows = useMemo(() => {
		// Sorted once per projects identity; shared with the unopened-agent
		// list (SpacesPane) through the WeakMap in projectIndexFor.
		const projectIndex = projectIndexFor(projects);
		const hostById = new Map(sshHosts.map((host) => [host.id, host]));
		const desktopById = new Map(spaces.map((desktop) => [desktop.id, desktop]));
		const openSpaces = excludeHiddenAgentPanes(openPanes, hiddenPanes);
		const openAgentIds = new Set(
			openSpaces
				.map((space) => space.agentId)
				.filter((agentId): agentId is string => Boolean(agentId)),
		);
		// 숨긴 에이전트는 원래 데스크탑 자리에 hidden 행으로 남는다 —
		// "안 연 에이전트"로 강등하지 않는다(사용자 지적 2026-08-01).
		// 기록 해제는 AgentPanel 마운트가 한다 — 렌더 중 store를 지우면
		// "기록 저장 → 다음 태스크에 pane 제거" 사이의 리렌더가 방금 숨긴
		// 기록을 자가치유로 삼켜 unopened로 떨어졌다(실제 재현 2026-08-01).
		const hiddenSpaces: Space[] = [];
		for (const [agentId, record] of Object.entries(hiddenPanes)) {
			if (openAgentIds.has(agentId)) continue;
			if (!agentById.has(agentId)) continue;
			if (!desktopOrder.includes(record.desktopId)) continue;
			hiddenSpaces.push({
				key: record.paneId,
				desktopId: record.desktopId,
				sessionId: "",
				kind: "agent",
				agentId,
				hidden: true,
			});
		}
		return [...openSpaces, ...hiddenSpaces].map((space) => {
			const agent = space.agentId ? agentById.get(space.agentId) : undefined;
			const sessionId =
				space.kind === "agent" ? (agent?.sessionId ?? "") : space.sessionId;
			const executionLocation =
				space.kind === "term"
					? getTerminalExecutionLocation(sessionId)
					: undefined;
			const nestedSsh =
				executionLocation?.kind === "ssh" ? executionLocation : undefined;
			const executionLocationKnown =
				!space.hmuxIdentity ||
				(hasTerminalExecutionLocationObservation(sessionId) &&
					executionLocation?.kind !== "unknown");
			const effectiveKind = nestedSsh ? "ssh" : space.kind;
			const cwd = nestedSsh
				? ""
				: sessionCwd[sessionId] || space.cwd || agent?.worktreePath || "";
			const provider: Provider | null =
				space.kind === "agent"
					? (agent?.provider ?? null)
					: (sessionAgentPin[sessionId] ?? sessionAgent[sessionId] ?? null);
			const project = projectIndex.resolveByCwd(cwd);
			const agentProject = agent
				? projectIndex.byId.get(agent.projectId)
				: undefined;
			const repositoryProject = space.kind === "agent" ? agentProject : project;
			const hostId =
				space.hostId ??
				(agent && REMOTE_SESSION_KINDS.has(agent.sessionKind)
					? agentProject?.sshHostId
					: undefined);
			const host = hostId ? hostById.get(hostId) : undefined;
			const hostLabel =
				nestedSsh?.target ??
				host?.name ??
				(hostId ? t("common.remote") : t("common.local"));
			// Where the pane sits inside its repository. The repository heading
			// already names the folder, so the root is "" (nothing to add), a
			// worktree or subfolder is its path below the root, and a cwd outside
			// every registered repository keeps its last two segments.
			const relativePath = project
				? cwd === project.path
					? ""
					: cwd.startsWith(`${project.path}/`)
						? cwd
								.slice(project.path.length + 1)
								.replace(/^\.worktrees\//, "worktree/")
						: cwd.split("/").filter(Boolean).slice(-2).join("/")
				: cwd.split("/").filter(Boolean).slice(-2).join("/");
			const runtimeTitle = agent
				? (conversationTitle(agent.id) ??
					observedTitle(sessionTitle[sessionId], agent.conversationId))
				: undefined;
			const explicitAgentTitle = agent
				? normalizeAgentDisplayName(agent.name, agent.displayName)
				: undefined;
			const title = agent
				? resolveAgentPaneTitle({
						name: agent.name,
						displayName: agent.displayName,
						runtimeTitle,
						opaqueConversationId: agent.conversationId,
						directoryCandidates: [cwd, agent.worktreePath],
					})
				: nestedSsh?.target ||
					(provider ? PROVIDERS[provider].label : "") ||
					spaceBasename(cwd) ||
					t("spaces.session.shell");
			// PaneChrome과 같은 제목 권위를 쓴다. 사용자가 지정한 이름이
			// 있으면 그 이름을, 없으면 provider conversation title을 첫 줄에
			// 둔다. 최근 prompt와 경로는 정보 줄에만 남는다.
			// 인덱스 접근은 undefined를 타입에 남기지 않는다(noUncheckedIndexedAccess
			// 미사용) — 초기값 캐스트여야 흐름 분석이 유니온을 다시 좁히지 못해
			// 행 스키마의 activityAt이 number로 굳지 않는다.
			const activityEntry = sessionActivity[sessionId] as
				| { text: string; at?: number }
				| undefined;
			const detail = spaceRowDetail({
				kind: space.kind,
				cwd,
				nestedSsh: Boolean(nestedSsh),
				relativePath,
				activityText: agent
					? activityEntry?.text ||
						conversationPrompt(agent.id, managedConversationId(agent))
					: undefined,
				// The provider-reported thread name when a chat session has observed
				// one; otherwise the OSC 0/2 title the CLI set, which the Host
				// projects into sessionTitle — the same source the pane header reads.
				conversationTitle: explicitAgentTitle ? runtimeTitle : undefined,
			});
			const terminalRuntime = sessionAgentRuntimeState[sessionId];
			const displayState = agent
				? presentedAgentDisplayState(
						displayStates[agent.id],
						activity[agent.id],
					)
				: provider
					? sessionRuntimeDisplayState(terminalRuntime)
					: undefined;
			const metadataKey = space.hmuxIdentity
				? hmuxSessionMetadataKey(
						space.hmuxIdentity.workspaceId,
						space.hmuxIdentity.sessionId,
					)
				: undefined;
			const managedPromotion =
				interfaceMode === "basic"
					? ("hidden" as const)
					: hmuxManagedPromotionAvailability(
							{
								kind: effectiveKind,
								hostId,
								runtime: space.hmuxIdentity?.runtime,
								workspaceId: space.hmuxIdentity?.workspaceId,
								provider,
								executionLocationKnown,
								displayState,
								cwd,
							},
							projects,
						);

			return {
				key: space.key,
				desktopId: space.desktopId,
				desktopName: desktopById.get(space.desktopId)?.name ?? "",
				sessionId,
				kind: effectiveKind,
				agentId: space.agentId,
				cwd,
				title,
				detail: detail.text,
				detailSource: detail.source,
				/** 최근 활동 시각 — 행 정보줄 오른쪽의 상대시간용. */
				activityAt: agentRowActivityAt(
					activityEntry,
					agent
						? conversationActivityAt(agent.id, managedConversationId(agent))
						: undefined,
				),
				/** 시안의 프로젝트 그룹 머리행에 쓰는 소속 프로젝트 */
				projectId: repositoryProject?.id,
				projectName: repositoryProject?.name ?? hostLabel,
				relativePath,
				branch: agent?.branch,
				hostLabel,
				/** 원격 세션의 host id (로컬이면 undefined) — 추가 위치 목록용 */
				hostId,
				provider,
				executionLocationKnown,
				hmuxRuntime: space.hmuxIdentity?.runtime,
				hmuxWorkspaceId: space.hmuxIdentity?.workspaceId,
				/** 이 줄이 가리키는 hmux 세션 id — 폰이 세션을 알아보는 유일한
				 *  값이다. 에이전트 pane 은 이것을 자기 안에 들고 있지 않아
				 *  규칙이 한 군데에 있다(`paneHmuxSessionId`). */
				hmuxSessionId: paneHmuxSessionId(space, agent),
				hmuxSessionName: metadataKey
					? sessionNameByMetadataKey[metadataKey]
					: undefined,
				managedPromotion,
				/** hmux host 빌드(version+git12) — 다중 빌드 공존 가시화 (tooltip용) */
				hostBuild: metadataKey
					? hostBuildByMetadataKey[metadataKey]
					: undefined,
				// B2 표시 상태 — 에이전트는 watcher 해석값, 터미널은 프로바이더가
				// 붙었을 때만 legacy 활동값 그대로. (행의 상태 신호는 이것 하나다.)
				displayState,
				unread: agent ? isAgentUnread(episodes, acks, agent.id) : false,
				...(space.hidden ? { hidden: true as const } : {}),
			};
		});
	}, [
		interfaceMode,
		spaces,
		hiddenPanes,
		openPanes,
		desktopOrder,
		executionLocationRevision,
		titleRevision,
		agentById,
		sessionCwd,
		sessionTitle,
		sessionAgentPin,
		sessionAgent,
		projects,
		sshHosts,
		sessionActivity,
		activity,
		sessionAgentRuntimeState,
		displayStates,
		episodes,
		acks,
		hostBuildByMetadataKey,
		sessionNameByMetadataKey,
	]);

	// 재계산은 허용하되 내용이 같으면 이전 참조를 재사용 — 배열·행 정체성이
	// 유지돼 하위 memo(행·그룹·locationsByDesktop)가 깨지지 않는다. 렌더 중
	// ref 대입은 이전-값 캐시 용도라, 중단된 렌더가 값을 남겨도 다음 비교의
	// 기준이 될 뿐 정확성에는 영향이 없다.
	const previousRows = useRef<readonly (typeof rows)[number][]>(undefined);
	const stableRows = reuseStableRows(previousRows.current, rows);
	previousRows.current = stableRows;
	// readonly 유지 — 소비자가 캐시된 배열을 제자리 정렬하면 재사용 기준이
	// 오염된다.
	return stableRows;
}

/** 화면에 그릴 준비가 끝난 스페이스 한 줄 (내부 분류 타입 `Space`와 구분) */
export type SpaceRow = ReturnType<typeof useSpaces>[number];
