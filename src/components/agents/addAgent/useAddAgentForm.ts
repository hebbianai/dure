// 에이전트 추가 다이얼로그의 상태 묶음.
//
// 컴포넌트는 렌더와 배선만 맡는다는 규약(AGENTS.md 프런트엔드 관례)에 따라
// 상태·비동기 조회를 여기로 뺀다. 계산 자체는 addAgentForm/gh/setupRun의
// 순수 함수가 하고, 이 훅은 그것들을 시간축에 붙일 뿐이다.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	useAvailableProviders,
	useVisibleProviders,
} from "@/lib/agents/agentInstalls";
import { resolveDefaultProvider } from "@/lib/agents/defaultProvider";
import { useStore } from "@/store";
import type { Project, Provider } from "@/types";
import {
  DEFAULT_WORKTREE_ROOT,
  hostOptions,
  modeChoiceForTab,
  projectsForHost,
  recentProjectChips,
  type AgentPermission,
  type WorktreeRoot,
  type WorktreeTab,
} from "@/lib/agents/addAgentForm";
import { branchNameForWorkItem, parseWorkItemRef, type GhWorkItem } from "@/lib/github/gh";
import { ghAuthState, ghWorkItem, ghWorkItems } from "@/lib/ipc/github";
import { authRemediation, type GhAuthState } from "@/lib/github/gh";
import { probeSetupCommand } from "@/lib/agents/setupRun";
import { listDir, listRemoteDir } from "@/lib/ipc";
import { t } from "@/lib/i18n";
import { initialAgentLaunchAccountId } from "@/lib/agents/agentLaunchCredential";
import { providerSupportsAccountProfiles } from "@/lib/agents/providerCredentials";
import { supportsStructuredChat } from "@/lib/agents/providers";
import { projectAtPath } from "@/lib/spaces/projectAdd";

/** gh 인증이 준비되지 않았을 때 Github 탭에 띄울 안내. 번역은 여기서 건다 —
 *  gh.ts는 키만 주고 완성된 문장을 만들지 않는다(기본 언어가 영어다). */
function ghHint(tab: WorktreeTab, state: GhAuthState | null) {
  if (tab !== "github" || !state || state.kind === "ready") return null;
  const remediation = authRemediation(state);
  if (!remediation) return null;
  return { text: t(remediation.key, remediation.params), tone: "warn" as const };
}

export function useAddAgentForm(
  initialHostId: string | null,
  initialProvider?: Provider,
  /** Local Home inspection. It remains ephemeral until the user submits. */
  defaultProject?: Project | null,
  /** 호출부가 방금 확보한 프로젝트 — 목록에 나타나는 대로 이걸 고른다.
   *  initialPath로 열었거나 사용자가 폴더를 새로 고른 경우다. seq는 요청마다
   *  증가해, 같은 폴더를 다시 골라도 선택이 무시되지 않게 한다. */
  selection?: { projectId: string; seq: number } | null,
) {
  const projects = useStore((state) => state.projects);
  const sshHosts = useStore((state) => state.sshHosts);
  const accounts = useStore((state) => state.accounts);

  const [hostId, setHostId] = useState<string | null>(initialHostId);
  const [project, setProject] = useState<Project | null>(null);
  const [tab, setTab] = useState<WorktreeTab>("smart");
  const [query, setQuery] = useState("");
  // An explicit initialProvider (e.g. "new agent like this one") wins; otherwise
  // the stored default-agent preference, resolved against what is installed.
  const availableProviders = useAvailableProviders();
  const visibleProviders = useVisibleProviders();
  const preferredProvider = useStore((s) => s.uiPrefs.defaultProvider);
  const resolvedInitialProvider =
    initialProvider && visibleProviders.includes(initialProvider)
      ? initialProvider
      : resolveDefaultProvider(preferredProvider, availableProviders);
  const [provider, setProvider] = useState<Provider>(resolvedInitialProvider);
  const [selectedAccountId, setAccountId] = useState<string | null>(() => {
    const state = useStore.getState();
    const selectedProvider = resolvedInitialProvider;
    return initialAgentLaunchAccountId(
      selectedProvider,
      state.accounts,
      state.activeAccounts[selectedProvider],
    );
  });
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [worktreeRoot, setWorktreeRoot] = useState<WorktreeRoot>(DEFAULT_WORKTREE_ROOT);
  const [permission, setPermission] = useState<AgentPermission>("inherit");
  const choosePermission = useCallback((next: AgentPermission) => {
    setPermission(next);
  }, []);
  const chooseProvider = useCallback((next: Provider) => {
    setProvider(next);
    const state = useStore.getState();
    setAccountId(
      initialAgentLaunchAccountId(
        next,
        state.accounts,
        state.activeAccounts[next],
      ),
    );
  }, []);
  if (!visibleProviders.includes(provider)) {
    chooseProvider(resolveDefaultProvider(preferredProvider, availableProviders));
  }
  const [runSetup, setRunSetup] = useState(
    () => initialHostId !== null || !supportsStructuredChat(resolvedInitialProvider),
  );
  const [ghState, setGhState] = useState<GhAuthState | null>(null);
  const [ghItems, setGhItems] = useState<GhWorkItem[]>([]);
  const [setupCommand, setSetupCommand] = useState<string | null>(null);

  useEffect(() => {
    setRunSetup(hostId !== null || !supportsStructuredChat(provider));
  }, [hostId, provider]);

  const hosts = useMemo(() => hostOptions(projects, sshHosts), [projects, sshHosts]);
  const hostProjects = useMemo(() => {
    const registered = projectsForHost(projects, hostId);
    if (hostId !== null || !defaultProject) return registered;
    const existing = projectAtPath(projects, defaultProject.path);
    return existing ? registered : [...registered, defaultProject];
  }, [projects, hostId, defaultProject]);
  const recents = useMemo(
    // 사용 시각을 따로 보관하지 않으므로 목록 순서를 최근 순의 근사로 쓴다.
    () => recentProjectChips(projects, hostId, {}, 4),
    [projects, hostId],
  );
  const credentialAccounts = useMemo(
    () =>
      providerSupportsAccountProfiles(provider)
        ? accounts.filter((account) => account.provider === provider)
        : undefined,
    [accounts, provider],
  );
  // A deleted or provider-mismatched profile immediately falls back to the
  // explicit default. The store repeats authoritative validation at launch.
  const accountId = credentialAccounts?.some(
    (account) => account.id === selectedAccountId,
  )
    ? selectedAccountId
    : null;

  // 호스트를 바꾸면 이전 호스트의 프로젝트가 선택으로 남으면 안 된다.
  useEffect(() => {
    setProject((current) =>
      hostProjects.find((candidate) => candidate.id === current?.id) ?? hostProjects[0] ?? null,
    );
  }, [hostProjects]);

  // 호출부가 확보한 프로젝트를 고른다.
  //
  // 위 효과가 이미 hostProjects[0]을 넣어 둔 뒤에 목록이 갱신되므로, "현재 선택이
  // 유효하면 둔다"만으로는 이 선택이 절대 반영되지 않는다. 요청 일련번호마다 한
  // 번만 적용해 사용자가 그 뒤에 다른 걸 고르면 덮어쓰지 않게 한다. id가 아니라
  // 일련번호로 세는 이유: 같은 폴더를 다시 고르면 id가 그대로라 무시돼 버린다.
  //
  // 전체 projects에서 찾아 호스트까지 함께 옮긴다 — hostProjects 안에서만 찾으면
  // 원격 폴더를 골랐을 때 레일이 로컬에 남아 선택이 영영 반영되지 않는다.
  const appliedSelectionRef = useRef(-1);
  useEffect(() => {
    if (!selection || appliedSelectionRef.current === selection.seq) return;
    const match = projects.find((candidate) => candidate.id === selection.projectId);
    if (!match) return;
    appliedSelectionRef.current = selection.seq;
    setHostId(match.kind === "ssh" ? (match.sshHostId ?? null) : null);
    setProject(match);
  }, [selection, projects]);

  // Github 탭에 들어갈 때만 인증을 확인한다 — 다른 탭에서 gh를 부르면
  // 쓰지도 않을 조회로 다이얼로그 열기가 느려진다.
  useEffect(() => {
    if (tab !== "github" || ghState) return;
    let disposed = false;
    void ghAuthState().then((state) => {
      if (!disposed) setGhState(state);
    });
    return () => {
      disposed = true;
    };
  }, [tab, ghState]);

  // Github 탭 조회 — 번호/URL이면 단건, 아니면 검색.
  useEffect(() => {
    if (tab !== "github" || !project || ghState?.kind !== "ready") {
      setGhItems([]);
      return;
    }
    let disposed = false;
    const timer = setTimeout(() => {
      const ref = parseWorkItemRef(query);
      // 이슈와 PR을 함께 본다 — PR만 검색에서 빠지면 headRefName으로 그 PR
      // 브랜치를 이어받는 길이 번호를 정확히 아는 경우에만 열린다.
      const load = ref
        ? Promise.all([
            ghWorkItem(project.path, "issue", ref),
            ghWorkItem(project.path, "pr", ref),
          ]).then((found) => found.filter((item): item is GhWorkItem => item !== null))
        : Promise.all([
            ghWorkItems(project.path, "issue", query),
            ghWorkItems(project.path, "pr", query),
          ]).then(([issues, prs]) => [...prs, ...issues]);
      void load.then((items) => {
        if (!disposed) setGhItems(items);
      });
    }, 250);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [tab, project, query, ghState]);

  // 이 워크트리에서 실제로 돌 setup 명령. 없으면 스위치가 잠긴다.
  // The judgment itself (what to look at, what to pick) now lives in
  // setupRun's probeSetupCommand; only the local-vs-remote list function
  // choice and state wiring stay here.
  // 원격은 반드시 listRemoteDir로 가야 한다:
  // list_dir는 std::fs::read_dir라 이 머신을 본다. 원격 경로로 부르면 대개
  // 실패해 "돌릴 것 없음"이 되고, 하필 같은 경로가 로컬에도 있으면 로컬
  // 락파일을 보고 정한 명령을 원격에서 돌리게 된다.
  useEffect(() => {
    if (!project) {
      setSetupCommand(null);
      return;
    }
    const host =
      project.kind === "ssh"
        ? sshHosts.find((candidate) => candidate.id === project.sshHostId)
        : undefined;
    if (project.kind === "ssh" && !host) {
      setSetupCommand(null);
      return;
    }
    let disposed = false;
    const base = project.path.replace(/\/+$/, "");
    const list = (path: string) =>
      host ? listRemoteDir(host, path, true) : listDir(path, true);
    void probeSetupCommand(list, base).then((command) => {
      if (!disposed) setSetupCommand(command);
    });
    return () => {
      disposed = true;
    };
  }, [project, sshHosts]);

  /** Github 항목을 고르면 브랜치 이름으로 바꿔 검색창에 넣는다 — 사용자가
   *  무엇이 만들어질지 보고 고칠 수 있어야 한다. */
  const pickSuggestion = (value: string | GhWorkItem) => {
    setQuery(typeof value === "string" ? value : branchNameForWorkItem(value));
  };

  return {
    hosts,
    hostId,
    setHostId,
    hostProjects,
    project,
    setProject,
    recents,
    tab,
    setTab,
    query,
    setQuery,
    provider,
    setProvider: chooseProvider,
    accountId,
    setAccountId,
    credentialAccounts,
    advancedOpen,
    setAdvancedOpen,
    worktreeRoot,
    setWorktreeRoot,
    permission,
    setPermission: choosePermission,
    runSetup,
    setRunSetup,
    setupCommand,
    modeChoice: modeChoiceForTab(tab),
    ghItems,
    ghHint: ghHint(tab, ghState),
    pickSuggestion,
  };
}
