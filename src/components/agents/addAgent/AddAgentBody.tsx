// 에이전트 추가 다이얼로그 본체 (시안 2256:29002 / 29090).
//
// 기존 2단계(WorktreeAgentDialog로 디렉터리 → AddAgentDialog로 나머지)를 한
// 화면으로 합친 것이다. 조각은 addAgent/*, 계산은 lib의 순수 함수가 맡고
// 여기서는 배치와 생성 호출만 한다.

import { useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, Command as CommandIcon } from "lucide-react";
import {
  type CanonicalAddAgentPresentationResult,
  type CanonicalAddAgentRunPolicy,
  type PreparedCanonicalAddAgentRun,
  prepareCanonicalAddAgentRun,
  runPreparedCanonicalAddAgentPresenting,
  shouldRetryCanonicalAddAgentAction,
  supportsCanonicalAddAgentRun,
} from "@/lib/agents/addAgentCanonicalRun";
import {
  isRemoteCredentialUnavailable,
  prepareRemoteAccountLogin,
} from "@/lib/agents/remoteAccountOverlay";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { AccountProfile, Agent, Project, Provider, SshHostConfig } from "@/types";
import { PROVIDERS } from "@/types";
import {
  openAgentPanelOnDesktop,
  openRemoteSshTerminalOn,
  withDesktopDockview,
} from "@/lib/workspace/dock";
import { openCommandTerminalOn } from "@/lib/workspace/dock/openCommandTerminal";
import { spaceWindowLabel } from "@/lib/workspace/window/windowLabel";
import { planSetupLaunch, setupShellCommand, type SetupLaunch } from "@/lib/agents/setupRun";
import { loadRepoBranchState } from "@/lib/agents/repoBranchLoad";
import {
  defaultBaseRef,
  defaultBranchName,
  planFromDialog,
  type BranchInfo,
  type WorktreeSummary,
} from "@/lib/scm/worktrees/worktreePlan";
import { requireProjectProvider } from "@/lib/agents/providerPreflight";
import { useAvailableProviders } from "@/lib/agents/agentInstalls";
import {
  canSubmit,
  deriveAgentName,
  permissionToOverride,
  permissionToSkipPermissions,
} from "@/lib/agents/addAgentForm";
import { beginManagedRuntimeEnsure } from "@/lib/sessions/launch/managedRuntimeEnsure";
import { ensureProviderLaunchDefaultsProjection } from "@/lib/settings/providerLaunchDefaults";
import {
  inspectExistingWorktree,
  recoverExistingWorktreeOwnership,
  spawnJournal,
  type ExistingWorktreeCandidate,
  type ExistingWorktreeList,
} from "@/lib/ipc";
import { loadExistingWorktreeList } from "@/lib/agents/existingWorktreeListLoad";
import {
  artifactDispositionFromReceipt,
  artifactIdFromReceipt,
  runSpawnSagaFromCli,
} from "@/lib/sessions/launch/spawnSaga";
import { spawnFailureMessage } from "@/lib/sessions/launch/spawnFailure";
import { ProviderGlyph } from "@/components/agents/ProviderLogo";
import { ProviderInstallGuidance, type ProviderSetupFailure } from "@/components/agents/ProviderInstallCommandRow";
import { providerInstallGuidanceForRun } from "@/lib/agents/providerInstallCommand";
import { HostRail } from "./HostRail";
import { LocationSection } from "./LocationSection";
import { Button } from "@/components/ui/button";
import { useInterfaceMode } from "@/components/workspace/useInterfaceMode";
import { agentSpawnInteractionPreference } from "@/lib/workspace/pane/interfaceMode";
import { WorktreeTabs } from "./WorktreeTabs";
import { AdvancedSection } from "./AdvancedSection";
import {
  ExistingWorktreeSelector,
  type WorktreeSource,
} from "./ExistingWorktreeSelector";
import { useAddAgentForm } from "./useAddAgentForm";
import {
  findAgentById,
  findSpaceById,
  readSkipPermissions,
  readSshHosts,
  useAddAgentBodyState,
} from "./useAddAgentBodyState";
import { SelectField, SelectOption } from "@/components/ui/select-field";
import { Switch } from "@/components/ui/switch";
import { GitAvailabilityNotice } from "@/components/scm/GitAvailabilityNotice";
import { useGitAvailability } from "@/components/scm/useGitAvailability";

interface DirectAgentCreation {
  agent: Agent;
  host?: SshHostConfig;
  account?: AccountProfile;
  desktopId: string;
  resume: () => Promise<void>;
}

/** 프로젝트가 원격이면 그 SSH 호스트 — setup을 거기서 돌려야 한다. */
function setupHost(
  project: Project | null,
  sshHosts: readonly SshHostConfig[],
): { id: string; name: string } | null {
  if (project?.kind !== "ssh" || !project.sshHostId) return null;
  const host = sshHosts.find((candidate) => candidate.id === project.sshHostId);
  return host ? { id: host.id, name: host.name } : null;
}

/** setup 명령을 터미널 pane에서 돌린다.
 *
 *  command pane으로 열기 때문에 명령이 실패해도 pane이 tombstone으로 남아
 *  사용자가 출력을 읽을 수 있다(TerminalPanel의 command pane 수명 규칙).
 *  다이얼로그가 곧 닫히므로 getDockview 대신 withDesktopDockview로 열어
 *  데스크탑 전환·마운트 지연을 견디게 한다. */
function openSetupPane(desktopId: string, launch: SetupLaunch): void {
  const title = t("setup · {command}", { command: launch.command });
  withDesktopDockview(desktopId, (api) => {
    if (launch.host) {
      openRemoteSshTerminalOn(
        api,
        launch.host.id,
        launch.host.name,
        launch.cwd,
        undefined,
        // 실행은 node 핀 해석 프리앰블을 붙인 셸 명령 — 제목은 원 명령 그대로.
        { commandLine: setupShellCommand(launch.command), title },
      );
      return;
    }
    openCommandTerminalOn(api, {
      title,
      command: setupShellCommand(launch.command),
      cwd: launch.cwd,
      // Setup that succeeded should vanish; failures keep their tombstone log.
      closeOnSuccess: true,
    });
  });
}

export function AddAgentBody({
  desktopId,
  initialHostId,
  initialProvider,
  defaultProject,
  selection,
  onClose,
  onCreated,
  onBrowse,
  onAddHost,
}: {
  desktopId?: string;
  initialHostId: string | null;
  initialProvider?: Provider;
  /** Home inspection shown as a local location without registering it yet. */
  defaultProject?: Project | null;
  /** 호출부가 확보한 프로젝트 — 목록에 나타나면 이걸 고른다 */
  selection?: { projectId: string; seq: number } | null;
  onClose: () => void;
  onCreated?: (agent: Agent) => void;
  /** 목록에 없는 폴더 고르기 — 호출부가 네이티브/SSH 브라우저를 띄운다 */
  onBrowse: (hostId: string | null) => void;
  onAddHost: () => void;
}) {
  // 기본 모드 간소화(2026-08-31): Advanced 섹션·워크트리 모드 탭·existing
  // 선택기는 접는다. 계정이 2개 이상이면 Advanced가 돌아오고(계정 선택이
  // 그 안에 있다), 차단 배너의 "기존 사용"이 existing을 고르면 선택기가
  // 돌아온다 — 숨은 상태가 몰래 동작하지 않는다.
  const interfaceMode = useInterfaceMode();
  const form = useAddAgentForm(
    initialHostId,
    initialProvider,
    defaultProject,
    selection,
  );
  const {
    agents,
    sshHosts,
    addAgent,
    ensureProjectForPath,
    activeSpaceId,
  } = useAddAgentBodyState();
  const availableProviders = useAvailableProviders();

  const [useWorktree, setUseWorktree] = useState(true);
  const [worktreeSource, setWorktreeSource] = useState<WorktreeSource>("new");
  const [existingWorktrees, setExistingWorktrees] = useState<ExistingWorktreeList | null>(null);
  const [selectedExistingPath, setSelectedExistingPath] = useState("");
  const [existingWorktreesLoading, setExistingWorktreesLoading] = useState(false);
  const [existingWorktreesError, setExistingWorktreesError] = useState<string | null>(null);
  const [existingWorktreesRequest, setExistingWorktreesRequest] = useState(0);
  const [preferredExistingPath, setPreferredExistingPath] = useState("");
  const [recoveringExistingPath, setRecoveringExistingPath] = useState<string | null>(null);
  const [inspectingExistingPath, setInspectingExistingPath] = useState<string | null>(null);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [worktrees, setWorktrees] = useState<WorktreeSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ProviderSetupFailure | null>(null);
  const error = failure?.cause;
  const setError = (cause: unknown, guide?: ProviderSetupFailure["guide"]) =>
    setFailure(cause == null ? null : { cause, guide });
  const canonicalActionRef = useRef<Promise<PreparedCanonicalAddAgentRun> | null>(null);
  const directCreationRef = useRef<DirectAgentCreation | null>(null);

  const project = form.project;
  const git = useGitAvailability(form.hostId, Boolean(project?.isRepo));
  const gitBlocked = git.state.status === "missing" || git.state.status === "checking";
  const canSelectExisting = project?.kind === "local" && !onCreated;
  const existingMode = Boolean(project?.isRepo) &&
    useWorktree &&
    canSelectExisting &&
    worktreeSource === "existing";
  const selectedExistingWorktree = useMemo<ExistingWorktreeCandidate | undefined>(
    () =>
      existingWorktrees?.worktrees.find(
        (candidate) => candidate.reference.canonicalPath === selectedExistingPath,
      ),
    [existingWorktrees, selectedExistingPath],
  );
  const name = useMemo(() => {
    const count = agents.filter((a) => a.projectId === project?.id).length + 1;
    return `${form.provider}-${count}`;
  }, [agents, project?.id, form.provider]);

  useEffect(() => {
    setWorktreeSource("new");
    setSelectedExistingPath("");
    setPreferredExistingPath("");
    setExistingWorktrees(null);
    setExistingWorktreesError(null);
  }, [project?.id]);

  useEffect(() => {
    if (!existingMode || !project || project.kind !== "local" || gitBlocked) {
      setExistingWorktreesLoading(false);
      return;
    }
    let disposed = false;
    setExistingWorktreesLoading(true);
    setExistingWorktreesError(null);
    setExistingWorktrees(null);
    void loadExistingWorktreeList(project.path, preferredExistingPath || undefined)
      .then((result) => {
        if (!disposed) setExistingWorktrees(result);
      })
      .catch((cause) => {
        if (!disposed) {
          setExistingWorktrees(null);
          setExistingWorktreesError(String(cause));
        }
      })
      .finally(() => {
        if (!disposed) setExistingWorktreesLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [
    existingMode,
    gitBlocked,
    project?.id,
    project?.kind,
    project?.path,
    existingWorktreesRequest,
    preferredExistingPath,
  ]);

  // 브랜치·워크트리 목록 — 로컬과 원격(SSH) 모두 비차단 로드.
  //
  // sshHosts는 구독하지 않고 실행 시점 값만 읽는다: 구독하면 로컬 프로젝트에서도
  // 호스트 목록이 바뀔 때마다 이 로드가 다시 돈다.
  useEffect(() => {
    if (!project?.isRepo || !useWorktree || existingMode) {
      setLoaded(true);
      return;
    }
    let disposed = false;
    setLoaded(false);
    // 이전 저장소의 목록을 비운다 — 남겨 두면 브랜치 탭 제안과 기준 목록이
    // 잠시 다른 저장소의 것을 보여 준다.
    setBranches([]);
    setWorktrees([]);
    if (gitBlocked) return;
    void loadRepoBranchState(project, readSshHosts())
      .then((state) => {
        if (disposed) return;
        setBranches(state.branches);
        setWorktrees(state.worktrees);
      })
      .finally(() => {
        if (!disposed) setLoaded(true);
      });
    return () => {
      disposed = true;
    };
  }, [project?.isRepo, project?.kind, project?.path, project?.sshHostId, useWorktree, existingMode, gitBlocked]);

  const [baseRef, setBaseRef] = useState("");
  const view = useMemo(
    () =>
      planFromDialog({
        repoPath: project?.path ?? "",
        agentName: name,
        // 검색창에 넣은 값이 곧 브랜치다 — 비어 있으면 이름에서 파생한다.
        branchInput: form.query.trim() || defaultBranchName(name),
        modeChoice: form.modeChoice,
        baseRef: baseRef || defaultBaseRef(worktrees, branches),
        branches,
        worktrees,
        loaded,
        worktreeRoot: form.worktreeRoot,
      }),
    [
      project?.path,
      name,
      form.query,
      form.modeChoice,
      form.worktreeRoot,
      baseRef,
      branches,
      worktrees,
      loaded,
    ],
  );

  const worktreeOn = Boolean(project?.isRepo) && useWorktree;
  const ready = canSubmit({
    project,
    name,
    worktreePlanReady:
      !worktreeOn ||
      (!gitBlocked && (existingMode
        ? selectedExistingWorktree !== undefined
        : view.canStart)),
    busy,
  });

  const recoverStaleOwnership = async (candidate: ExistingWorktreeCandidate) => {
    if (project?.kind !== "local") return;
    setRecoveringExistingPath(candidate.reference.canonicalPath);
    setError(null);
    try {
      const result = await recoverExistingWorktreeOwnership(
        project.path,
        candidate.reference,
        candidate.ownership.claimReceiptId,
      );
      if (result.state === "refused") {
        throw new Error(`${result.message} ${result.recovery}`);
      }
      setExistingWorktrees(
        await loadExistingWorktreeList(project.path, candidate.reference.canonicalPath),
      );
    } catch (cause) {
      setError(cause);
    } finally {
      setRecoveringExistingPath(null);
    }
  };

  const inspectExistingOwnership = async (candidate: ExistingWorktreeCandidate) => {
    if (project?.kind !== "local") return;
    setInspectingExistingPath(candidate.reference.canonicalPath);
    setError(null);
    try {
      const inspected = await inspectExistingWorktree(project.path, candidate.reference);
      setExistingWorktrees((current) =>
        current
          ? {
              ...current,
              worktrees: current.worktrees.map((entry) =>
                entry.reference.gitDir === inspected.reference.gitDir ? inspected : entry,
              ),
            }
          : current,
      );
    } catch (cause) {
      setError(cause);
    } finally {
      setInspectingExistingPath((current) =>
        current === candidate.reference.canonicalPath ? null : current,
      );
    }
  };

  const chooseExistingWorktree = (path: string) => {
    setSelectedExistingPath(path);
    setPreferredExistingPath(path);
    setWorktreeSource("existing");
  };

  const submit = async () => {
    if (!project || busy || (!directCreationRef.current && !ready)) return;
    setBusy(true);
    setError(null);
    let preparedRun: PreparedCanonicalAddAgentRun | undefined;
    try {
      if (directCreationRef.current) {
        await directCreationRef.current.resume();
        onClose();
        return;
      }
      const launchProject = await ensureProjectForPath(
        project.path,
        project.kind === "ssh" ? project.sshHostId : undefined,
      );
      // A typed branch name is the identity the user thinks of the agent by —
      // register under it instead of the provider-N auto name (2026-08-04
      // "darwin registered as claude-26" report).
      const agentName = deriveAgentName({
        autoName: name,
        branch: existingMode
          ? selectedExistingWorktree?.reference.branch
          : worktreeOn
            ? view.plan.branch
            : undefined,
        branchWasTyped: existingMode || form.query.trim().length > 0,
        takenNames: agents
          .filter((candidate) => candidate.projectId === launchProject.id)
          .map((candidate) => candidate.name),
      });
      const permissionOverride = permissionToOverride(form.permission);
      const targetSpaceId = desktopId ?? activeSpaceId;
      const targetSpace = findSpaceById(targetSpaceId);
      const selectedAccount = form.accountId
        ? form.credentialAccounts?.find(
            (account) => account.id === form.accountId,
          )
        : undefined;
      const interactionPreference =
        agentSpawnInteractionPreference();
      const canonicalPolicy: CanonicalAddAgentRunPolicy = {
        project: launchProject,
        agentName,
        provider: form.provider,
        accountId: form.accountId,
        ...(selectedAccount ? { account: selectedAccount } : {}),
        useWorktree: worktreeOn && !existingMode,
        ...(existingMode && selectedExistingWorktree
          ? { existingCheckout: selectedExistingWorktree.reference }
          : worktreeOn ? { worktreePlan: view.plan } : {}),
        ...(permissionOverride ? { permissionOverride } : {}),
        setupCommand:
          form.runSetup && worktreeOn && !existingMode && form.setupCommand
            ? setupShellCommand(form.setupCommand)
            : null,
        ...(interactionPreference ? { interactionPreference } : {}),
        actionId: crypto.randomUUID(),
      };
      const canonicalRun = supportsCanonicalAddAgentRun(canonicalPolicy);
      if (canonicalRun) {
        const preparation =
          canonicalActionRef.current ?? prepareCanonicalAddAgentRun(canonicalPolicy);
        canonicalActionRef.current = preparation;
        try {
          preparedRun = await preparation;
        } catch (cause) {
          if (canonicalActionRef.current === preparation) {
            canonicalActionRef.current = null;
          }
          throw cause;
        }
        let result: CanonicalAddAgentPresentationResult;
        try {
          result = await runPreparedCanonicalAddAgentPresenting(
            preparedRun,
            onCreated || !targetSpace
              ? null
              : {
                  spaceId: targetSpaceId,
                  windowLabel: spaceWindowLabel(targetSpace),
                },
          );
        } catch (cause) {
          if (
            !shouldRetryCanonicalAddAgentAction(cause) &&
            canonicalActionRef.current === preparation
          ) {
            canonicalActionRef.current = null;
          }
          throw cause;
        }
        const run = result.run;
        const agent = findAgentById(run.agentId);
        if (!agent) throw new Error("agent_run_projection_missing");
        onCreated?.(agent);
        canonicalActionRef.current = null;
        onClose();
        return;
      }
      await requireProjectProvider(launchProject, form.provider);
      await ensureProviderLaunchDefaultsProjection();
      const skipPermissions = permissionToSkipPermissions(
        form.permission,
        Boolean(readSkipPermissions(form.provider)),
      );
      if (launchProject.kind === "local" && !onCreated) {
        // Journal-first path: the backend fsyncs the request before anything
        // runs, so the submission survives a webview reload the moment
        // createSaga resolves — the boot resume runner finishes it if this
        // orchestration dies (2026-08-04 patric/darwin incident class). The
        // saga itself registers the agent, opens its pane, and ensures the
        // managed session. The dialog stays mounted until the receipt is
        // terminal so pre-pane refusals have a persistent local error surface;
        // a reload still resumes from the already-durable request.
        const created = await spawnJournal.createSaga({
          project: launchProject.id,
          name: agentName,
          provider: form.provider,
          runtime: "hmux",
          useWorktree: worktreeOn,
          ...(existingMode && selectedExistingWorktree
            ? { existingWorktreeRef: selectedExistingWorktree.reference }
            : worktreeOn
            ? {
                worktreePlan: {
                  branch: view.plan.branch,
                  worktreePath: view.plan.worktreePath,
                  action: view.plan.action,
                  ...(view.plan.baseRef ? { baseRef: view.plan.baseRef } : {}),
                  ...(view.plan.worktreeRoot
                    ? { worktreeRoot: view.plan.worktreeRoot }
                    : {}),
                },
              }
            : {}),
          permissionMode: skipPermissions ? "skip-permissions" : "default",
          accountId: form.accountId,
        });
        const setupDesktopId = desktopId ?? activeSpaceId;
        const runSetup = form.runSetup;
        const setupCommand = form.setupCommand;
        await runSpawnSagaFromCli({ receiptId: created.receiptId });
        const receipt = await spawnJournal.receipt(created.receiptId);
        // Worktree/ownership refusals intentionally happen before a pane
        // exists. Keep the dialog open and show the durable step error here.
        if (receipt.state !== "succeeded") {
          setError(
            t("agents.add.startFailed", {
              error: spawnFailureMessage(receipt),
            }),
          );
          return;
        }
        const worktreePath = artifactIdFromReceipt(
          receipt,
          "worktree",
          "worktree",
        );
        const disposition = artifactDispositionFromReceipt(
          receipt,
          "worktree",
          "worktree",
        );
        const launch = planSetupLaunch({
          runSetup,
          createdWorktree: Boolean(
            disposition === "created" &&
              worktreePath &&
              worktreePath !== launchProject.path,
          ),
          command: setupCommand,
          cwd: worktreePath ?? launchProject.path,
          host: null,
        });
        if (launch) openSetupPane(setupDesktopId, launch);
        onClose();
        return;
      }

      // Legacy direct path — SSH projects and programmatic callers that need
      // the Agent back synchronously (onCreated).
      const agent = await addAgent({
        projectId: launchProject.id,
        name: agentName,
        provider: form.provider,
        skipPermissions,
        accountId: form.accountId,
        useWorktree: worktreeOn,
        worktreePlan: worktreeOn ? view.plan : undefined,
      });
      const launch = planSetupLaunch({
        runSetup: form.runSetup,
        // 워크트리를 안 쓰면 provisionAgentWorktree가 프로젝트 루트를 그대로
        // 돌려준다 — 거기서 install을 돌리면 사용자의 본 체크아웃을 건드린다.
        createdWorktree:
          worktreeOn && agent.worktreePath !== launchProject.path,
        command: form.setupCommand,
        cwd: agent.worktreePath,
        host: setupHost(launchProject, sshHosts),
      });
      // Keep the registered Agent and launch inputs across explicit retries.
      // Neither login nor a retry may register another pane or worktree.
      const creation: DirectAgentCreation = {
        agent,
        host: sshHosts.find((host) => host.id === launchProject.sshHostId),
        account: selectedAccount,
        desktopId: targetSpaceId,
        resume: async () => {
          let launched = agent;
          const runtime = beginManagedRuntimeEnsure(agent, { columns: 120, rows: 30 });
          if (runtime?.source === "ssh") {
            launched = (await runtime.receipt).agent;
          } else if (runtime) {
            void runtime.receipt.catch((cause) =>
              console.warn("[addAgent] immediate ensure failed:", cause),
            );
          }
          if (onCreated) onCreated(launched);
          else openAgentPanelOnDesktop(targetSpaceId, launched);
        },
      };
      directCreationRef.current = creation;
      // Setup belongs to the created worktree, not provider authentication.
      // Open it once before login can transfer focus out of this dialog.
      if (launch) openSetupPane(targetSpaceId, launch);
      await creation.resume();

      onClose();
    } catch (cause) {
      setError(cause, providerInstallGuidanceForRun(cause, preparedRun && {
        provider: preparedRun.input.provider,
        source: preparedRun.routeAuthority.target.source,
      }));
    } finally {
      setBusy(false);
    }
  };

  // ⌘↵ 로 제출 (시안 2256:29087 단축키 표시).
  //
  // 최신 submit을 ref로 읽는다 — 의존성에 submit을 넣으면 렌더마다 리스너를
  // 떼었다 붙이고, 배열을 아예 빼도 같은 일이 벌어진다.
  const submitRef = useRef(submit);
  submitRef.current = submit;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        void submitRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const loginCreation = isRemoteCredentialUnavailable(error)
    ? directCreationRef.current
    : null;
  const openLogin = async () => {
    if (!loginCreation?.account || !loginCreation.host || busy) return;
    const { agent, account, host, desktopId: targetDesktopId } = loginCreation;
    setBusy(true);
    try {
      const commandLine = await prepareRemoteAccountLogin(host, agent.worktreePath, account);
      withDesktopDockview(targetDesktopId, (api) => {
        openRemoteSshTerminalOn(api, host.id, host.name, agent.worktreePath, undefined, {
          commandLine,
          title: t("common.loginWithName", { name: account.name }),
        });
        // The login pane must be usable, not hidden behind this modal.
        onClose();
      });
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  };

  return (
    // Columns stretch to the taller one: the rail draws the divider as its own
    // right border, so with items-start it only reached as far as its host
    // list and the line stopped partway down the body (owner report
    // 2026-09-08). Stretching also lets the rail's flex-1 list push "add SSH
    // host" to the bottom, where the comp (2256:29014) keeps it.
    <div className="flex w-full items-stretch">
      <fieldset className="contents" disabled={busy || Boolean(directCreationRef.current)}>
        <HostRail
          hosts={form.hosts}
          selectedHostId={form.hostId}
          onSelect={form.setHostId}
          onAddHost={onAddHost}
        />
      </fieldset>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-col gap-6 px-6 py-4">
          <fieldset className="contents" disabled={busy || Boolean(directCreationRef.current)}>
          <LocationSection
            projects={form.hostProjects}
            selected={project}
            recents={form.recents}
            homePath={defaultProject?.path}
            onSelect={form.setProject}
            onBrowse={() => onBrowse(form.hostId)}
            onEnvironmentReady={(remote) => {
              form.setHostId(remote.sshHostId ?? null);
              form.setProject(remote);
              setUseWorktree(true);
            }}
          />

          {project?.isRepo && (
            <div className="flex w-full flex-col gap-3">
              <GitAvailabilityNotice {...git} />
              {/* 설명 버튼과 Switch는 형제여야 한다 — Switch를 button 안에 넣으면
                  클릭이 onCheckedChange와 부모 onClick에 연달아 잡혀 서로 상쇄돼
                  토글이 먹지 않는다(중첩 인터랙티브 요소는 DOM에도 어긋난다). */}
              <div className="flex w-full items-start gap-3">
                <button
                  type="button"
                  onClick={() => setUseWorktree((prev) => !prev)}
                  className="flex min-w-0 flex-1 flex-col gap-1 text-left"
                >
                  <span className="text-xs leading-none font-medium text-foreground">
                    {t("agents.worktree.isolateDedicated")}
                  </span>
                  <span className="text-meta leading-4 text-muted-foreground">
                    {existingMode
                      ? t("agents.worktree.runInSelectedExisting")
                      : t("agents.worktree.createAndRun")}
                  </span>
                </button>
                <Switch
                  checked={useWorktree}
                  onCheckedChange={setUseWorktree}
                  aria-label={t("agents.worktree.isolateDedicated")}
                />
              </div>
              {useWorktree && (
                <>
                  {canSelectExisting &&
                    (interfaceMode === "pro" ||
                      worktreeSource === "existing") && (
                    <ExistingWorktreeSelector
                      source={worktreeSource}
                      onSourceChange={setWorktreeSource}
                      candidates={existingWorktrees?.worktrees ?? []}
                      selectedPath={selectedExistingPath}
                      onSelectedPathChange={setSelectedExistingPath}
                      loading={existingWorktreesLoading}
                      error={existingWorktreesError}
                      limit={existingWorktrees?.limit ?? 0}
                      truncated={existingWorktrees?.truncated ?? false}
                      recoveringPath={recoveringExistingPath}
                      inspectingPath={inspectingExistingPath}
                      onRecover={(candidate) => void recoverStaleOwnership(candidate)}
                      onInspect={(candidate) => void inspectExistingOwnership(candidate)}
                      onRetry={() => setExistingWorktreesRequest((request) => request + 1)}
                    />
                  )}
                  {!existingMode && (
                    <WorktreeTabs
                      hideModeTabs={interfaceMode === "basic"}
                      tab={form.tab}
                      onTabChange={form.setTab}
                      query={form.query}
                      onQueryChange={form.setQuery}
                      suggestions={form.tab === "github" ? form.ghItems : view.branchOptions}
                      onPickSuggestion={form.pickSuggestion}
                      hint={form.ghHint}
                    />
                  )}
                </>
              )}
              {/* When the plan is blocked, say why — without this the start button just
                  sits grayed out with no explanation, so the user cannot tell what to
                  fix. Do not show it before `loaded`: a plan computed before the branch
                  list arrives is always "no such branch", and right after switching
                  projects it looks at the previous repository's worktrees and emits
                  bogus conflict guidance. */}
              {useWorktree && !existingMode && loaded && view.banner && (
                <div className="flex items-start justify-between gap-3">
                  <p
                    role={view.banner.severity === "info" ? undefined : "alert"}
                    className={cn(
                      "text-meta leading-4 break-all",
                      view.banner.severity === "error"
                        ? "text-destructive"
                        : view.banner.severity === "warn"
                          ? "text-status-warn"
                          : "text-muted-foreground",
                    )}
                  >
                    {view.banner.message}
                  </p>
                  {view.banner.adoptPath && canSelectExisting && (
                    <button
                      type="button"
                      onClick={() => {
                        const path = view.banner?.adoptPath;
                        if (path) chooseExistingWorktree(path);
                      }}
                      className="shrink-0 rounded-md border border-border px-2.5 py-1.5 text-meta text-foreground hover:bg-muted"
                    >
                      {t("agents.worktree.useExisting")}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="flex w-full flex-col gap-2">
            <span className="text-xs leading-4 font-medium text-foreground">
              {t("common.agent")}
            </span>
            <SelectField
              aria-label={t("common.agent")}
              value={form.provider}
              onValueChange={(nextValue) => form.setProvider(nextValue as Provider)}
              leadingIcon={
                <ProviderGlyph provider={form.provider} className="size-3.5" />
              }
            >
              {availableProviders.map((candidate) => (
                <SelectOption key={candidate} value={candidate}>
                  {PROVIDERS[candidate].label}
                </SelectOption>
              ))}
            </SelectField>
          </div>

          {(interfaceMode === "pro" ||
            (form.credentialAccounts?.length ?? 0) > 1) && (
          <AdvancedSection
            open={form.advancedOpen}
            onToggle={() => form.setAdvancedOpen(!form.advancedOpen)}
            baseRef={baseRef || defaultBaseRef(worktrees, branches)}
            baseRefOptions={view.baseRefOptions}
            onBaseRefChange={setBaseRef}
            worktreeRoot={form.worktreeRoot}
            onWorktreeRootChange={form.setWorktreeRoot}
            permission={form.permission}
            onPermissionChange={form.setPermission}
            credentialId={form.accountId}
            credentialOptions={form.credentialAccounts?.map((account) => ({
              value: account.id,
              label: account.name,
            }))}
            onCredentialChange={form.setAccountId}
            showWorktreeCreationOptions={!existingMode}
            runSetup={form.runSetup}
            onRunSetupChange={form.setRunSetup}
            setupHint={form.setupCommand}
          />
          )}
          {interfaceMode === "basic" &&
            form.permission === "inherit" &&
            Boolean(readSkipPermissions(form.provider)) && (
              // Danger never folds: the machine default would launch this
              // agent with approvals off, and the switch that says so is in
              // the folded Advanced section.
              <p className="text-meta break-all text-destructive" role="alert">
                {t("agents.add.skipPermissionsDefaultWarn")}
              </p>
            )}

          </fieldset>
          {loginCreation?.account && loginCreation.host ? (
            <div className="flex flex-col items-start gap-2" role="status">
              <p className="text-meta text-muted-foreground">
                {t("agents.add.remoteLoginRequired", {
                  account: loginCreation.account.name,
                  host: loginCreation.host.name,
                })}
              </p>
              <Button type="button" disabled={busy} onClick={() => void openLogin()}>
                {t("agents.account.loginOnHost")}
              </Button>
            </div>
          ) : <ProviderInstallGuidance failure={failure} />}
        </div>

        {/* 2256:29082 — 오른쪽 정렬 기본 버튼 + ⌘↵ */}
        <div className="flex items-center justify-end px-6 pb-5">
          <Button
            type="button"
            size="lg"
            className="gap-2 px-4 shadow-xs"
            disabled={busy || (!directCreationRef.current && !ready)}
            onClick={() => void submit()}
          >
            {busy
              ? t("agents.add.creating")
              : t(directCreationRef.current || canonicalActionRef.current ? "common.retry" : "agents.add.submit")}
            <span className="flex items-center gap-1">
              <CommandIcon className="size-3" />
              <CornerDownLeft className="size-3" />
            </span>
          </Button>
        </div>
      </div>
    </div>
  );
}
