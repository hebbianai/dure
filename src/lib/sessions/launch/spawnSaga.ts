import { resolvePaneReference } from "@/lib/workspace/dock";
import { presentAgentPanelOnDockview } from "@/lib/workspace/dock/openAgentPanel";
import { preparePaneProjectionRemoval } from "@/lib/workspace/pane/paneCloseCoordinator";
import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import { getDockview } from "@/lib/workspace/dock/dockRegistry";
import { beginManagedRuntimeEnsure } from "@/lib/sessions/launch/managedRuntimeEnsure";
import { sendHmuxInitialAgentPrompt } from "@/lib/sessions/managed/managedAgentInput";
import { ManagedAgentInputError } from "@/lib/sessions/managed/managedAgentInputError";
import { ManagedCreateRetrySameError } from "@/lib/hmux/managed/managedCreateResolution";
import {
  hmux,
  spawnJournal,
  type SpawnReceipt,
  type ResolvedExistingWorktreeHandle,
} from "@/lib/ipc";
import { t } from "@/lib/i18n";
import { nanoid } from "nanoid";
import { ProviderPreflightError } from "@/lib/agents/providerPreflight";
import {
  launchAgentRegistrationEvidence,
  type LaunchAgentRegistrationEvidence,
  rollbackCreatedAgentRegistration,
} from "@/lib/agents/agentRegistrationRollback";
import { useStore } from "@/store";
import { addAgent } from "@/lib/agents/agentRegistration";
import type { Agent, Project, Provider } from "@/types";
import {
  parseSagaRequest,
  SagaStepError,
  type SagaPlacement,
  type SagaRequest,
} from "@/lib/sessions/launch/spawnSagaRequest";
import type { ProvisionedAgentWorktree } from "@/lib/agents/agentWorktreeProvision";
import {
  executeLaunchPromptDelivery,
  executePromptDelivery,
  PromptDeliveryManualError,
} from "@/lib/sessions/launch/spawnPromptDelivery";
import {
  existingHandleFromReceipt,
  materializeWorktree,
  revalidateExistingWorktreeHandle,
  requireExistingWorktreeHandle,
  resolveWorktreeIntent,
  worktreeArtifactFromReceipt,
  worktreeIntentFromReceipt,
} from "@/lib/sessions/launch/spawnWorktreeAuthority";

export { artifactDispositionFromReceipt } from "@/lib/sessions/launch/spawnWorktreeAuthority";

/** Spawn saga 오케스트레이터 (UC-03) — `POST /spawn/v2`가 journal에 saga를 만든 뒤
 *  `cli:request(action: "spawn.v2")`로 위임한 실행 본체. 원자성은 트랜잭션이 아니라
 *  idempotent saga + ownership-aware compensation으로 정의한다:
 *  - 각 단계는 journal(step_started/succeeded/failed)로 영속 기록된다.
 *  - 재실행(receiptId 재제출)은 ok 단계를 건너뛴다.
 *  - 실패 시 이번 실행이 만든(created_by_request) 산출물만 역순 정리한다.
 *    worktree는 정책상 항상 보존한다(no auto-delete).
 *  prompt 전달 증거는 Host의 원자적 write receipt를 그대로 기록한다(UC-04). */

type OwnedArtifact =
  | { kind: "agent_registration"; id: string }
  | { kind: "hmux_session"; id: string; workspaceId: string }
  | { kind: "pane"; id: string; desktopId: string; agentId: string };

interface OwnedAgentRegistration {
  readonly registration: Agent;
  readonly launchEvidence: LaunchAgentRegistrationEvidence;
}

/** 같은 receiptId의 saga가 이 webview에서 동시에 두 번 돌지 않게 한다
 * (StrictMode/중복 emit 방어 — 크로스 윈도우는 dispatch의 label 가드가 담당). */
const runningSagas = new Set<string>();

class SpawnJournalAppendError extends Error {
  constructor(
    readonly event: Record<string, unknown>,
    readonly reason: unknown,
  ) {
    super(`spawn journal append failed: ${String(reason)}`);
    this.name = "SpawnJournalAppendError";
  }
}

export async function runSpawnSagaFromCli(rawParams: Record<string, unknown>) {
  const receiptId = String(rawParams.receiptId ?? "");
  if (!receiptId) return;
  if (runningSagas.has(receiptId)) return;
  runningSagas.add(receiptId);
  try {
    await runSpawnSagaInner(receiptId, rawParams);
  } catch (error) {
    if (!(error instanceof SpawnJournalAppendError)) throw error;
    console.error(
      `[spawn saga ${receiptId}] ${String(error.event.event ?? "unknown")} append failed; execution stopped: ${String(error.reason)}`,
    );
  } finally {
    runningSagas.delete(receiptId);
  }
}

async function runSpawnSagaInner(
  receiptId: string,
  rawParams: Record<string, unknown>,
) {
  const journal = async (event: Record<string, unknown>) => {
    try {
      await spawnJournal.append(receiptId, event);
    } catch (error) {
      throw new SpawnJournalAppendError(event, error);
    }
  };

  let prior: SpawnReceipt;
  try {
    prior = await spawnJournal.receipt(receiptId);
  } catch (error) {
    console.error(`[spawn saga ${receiptId}] receipt unavailable: ${error}`);
    return;
  }
  if (["succeeded", "compensated"].includes(prior.state)) return;
  // 재개 계약: destructive boundary 이후에는 저장된 request만 authority다.
  // 라이브 값은 원문을 저널에 남기지 않는 prompt만 보충할 수 있다.
  const params: Record<string, unknown> = {
    ...(prior.request ?? {}),
    receiptId,
    ...(typeof rawParams.prompt === "string" && rawParams.prompt
      ? { prompt: rawParams.prompt }
      : {}),
  };
  const done = new Set(
    prior.steps.filter((step) => step.status === "ok").map((step) => step.step),
  );

  const owned: { artifact: OwnedArtifact; removePane?: () => boolean }[] = [];
  const createdAgentRegistrations = new Map<string, OwnedAgentRegistration>();
  const step = async <T>(
    name: string,
    run: () => Promise<{ detail?: unknown; value: T }>,
    startedDetail?: unknown,
  ): Promise<T | undefined> => {
    if (done.has(name)) return undefined;
    await journal({
      event: "step_started",
      step: name,
      ...(startedDetail !== undefined ? { detail: startedDetail } : {}),
    });
    try {
      const { detail, value } = await run();
      await journal({
        event: "step_succeeded",
        step: name,
        ...(detail !== undefined ? { detail } : {}),
      });
      return value;
    } catch (error) {
      if (error instanceof SpawnJournalAppendError) throw error;
      const code =
        error instanceof SagaStepError
          ? error.code
          : error instanceof ManagedCreateRetrySameError
            ? error.code
          : error instanceof ProviderPreflightError
            ? "provider_preflight_failed"
            : error instanceof PaneCommandError
              ? error.code
              : `${name}_failed`;
      const message = error instanceof Error ? error.message : String(error);
      await journal({
        event: "step_failed",
        step: name,
        error: {
          code,
          message,
          ...(error instanceof PromptDeliveryManualError && error.deliveryState
            ? { deliveryState: error.deliveryState }
            : {}),
        },
      });
      if (
        error instanceof PromptDeliveryManualError ||
        error instanceof ManagedCreateRetrySameError
      ) {
        throw error;
      }
      throw new SagaStepError(name, code, message);
    }
  };
  const skip = (name: string) =>
    done.has(name)
      ? Promise.resolve()
      : journal({ event: "step_skipped", step: name });
  const artifact = async (
    stepName: string,
    created: boolean,
    entry: OwnedArtifact & Record<string, unknown>,
    removePane?: () => boolean,
  ) => {
    await journal({
      event: created ? "artifact_created" : "artifact_adopted",
      step: stepName,
      artifact: entry,
    });
    // View handles remain request-local; only serializable artifacts enter the journal.
    if (created) owned.push({ artifact: entry, removePane });
  };

  try {
    const request = parseSagaRequest(params);
    const st = useStore.getState();
    const project =
      st.projects.find((candidate) => candidate.name === request.project) ??
      st.projects.find((candidate) => candidate.id === request.project);
    if (!project) {
      throw new SagaStepError(
        "preflight",
        "project_not_found",
        t("common.projectMissing", { project: request.project }),
      );
    }
    const priorAgentId = artifactIdFromReceipt(prior, "pane", "agent_registration");
    const priorAgent = priorAgentId
      ? st.agents.find((candidate) => candidate.id === priorAgentId)
      : undefined;
    const priorWorktreeIntent = worktreeIntentFromReceipt(prior);
    const agentName =
      request.name ||
      priorAgent?.name ||
      priorWorktreeIntent?.agentName ||
      defaultAgentName(st.agents, project, request.provider);

    // placement는 산출물을 만들기 전에 해석한다 — 실패가 compensation 없이 끝나도록.
    const placement = request.placement
      ? await resolveSagaPlacement(request.placement)
      : undefined;

    // Check request support here; the selected runtime owns provider preflight.
    await step("preflight", async () => {
      if (project.kind === "ssh" && request.useWorktree) {
        throw new SagaStepError(
          "preflight",
          "remote_worktree_unsupported",
          t("sessions.spawn.remoteWorktreeUnsupported"),
        );
      }
      return { detail: null, value: undefined };
    });

    // 2. worktree — 생성/재사용. 정책상 compensation 대상이 아니다(no auto-delete).
    let provisionedWorktree: ProvisionedAgentWorktree | undefined;
    let existingWorktreeHandle: ResolvedExistingWorktreeHandle | undefined;
    if (request.useWorktree) {
      if (done.has("worktree")) {
        provisionedWorktree = worktreeArtifactFromReceipt(prior);
        existingWorktreeHandle = existingHandleFromReceipt(prior);
      } else if (request.existingWorktreeRef) {
        const resolved = await step(
          "worktree",
          async () => {
            const handle = await requireExistingWorktreeHandle(request, project);
            await journal({
              event: "artifact_adopted",
              step: "worktree",
              artifact: {
                kind: "worktree",
                id: handle.reference.canonicalPath,
                branch: handle.reference.branch,
                disposition: handle.disposition,
                claimId: handle.claimId,
                gitCommonDir: handle.reference.gitCommonDir,
                gitDir: handle.reference.gitDir,
                head: handle.reference.head,
              },
            });
            return {
              detail: {
                disposition: handle.disposition,
                handle,
              },
              value: {
                worktree: {
                  path: handle.reference.canonicalPath,
                  branch: handle.reference.branch,
                },
                handle,
              },
            };
          },
          { existingWorktreeRef: request.existingWorktreeRef },
        );
        provisionedWorktree = resolved?.worktree;
        existingWorktreeHandle = resolved?.handle;
      } else {
        const intent =
          priorWorktreeIntent ??
          (await resolveWorktreeIntent(
            project.path,
            agentName,
            request.worktreePlan,
          ));
        const interruptedCreation =
          priorWorktreeIntent !== undefined &&
          prior.steps.some(
            (entry) => entry.step === "worktree" && entry.status === "running",
          );
        provisionedWorktree = await step("worktree", async () => {
          const materialized = await materializeWorktree(
            project.path,
            intent,
            request.worktreePlan,
            interruptedCreation,
          );
          await journal({
            event: materialized.created
              ? "artifact_created"
              : "artifact_adopted",
            step: "worktree",
            artifact: {
              kind: "worktree",
              id: materialized.worktree.path,
              branch: materialized.worktree.branch,
              disposition: materialized.created ? "created" : "reused",
            },
          });
          return {
            detail: {
              intent,
              worktree: materialized.worktree,
              disposition: materialized.created ? "created" : "reused",
            },
            value: materialized.worktree,
          };
        }, { intent });
      }
    } else {
      await skip("worktree");
    }

    // runtime 선택은 addAgent가 부여하는 runtimeBinding이 결정한다 — 로컬
    // 프로젝트는 기본 hmux_managed_v1(관리형 생성), 그 외는 legacy PTY 경로.
    // request.runtime은 하위 호환용 힌트로만 받는다.
    await runAgentRuntime(
      request,
      project,
      agentName,
      placement,
      {
        step,
        skip,
        artifact,
        journal,
        prior,
        createdAgentRegistrations,
      },
      provisionedWorktree,
      existingWorktreeHandle,
    );

    await journal({ event: "saga_finished", state: "succeeded" });
  } catch (error) {
    if (error instanceof SpawnJournalAppendError) throw error;
    if (error instanceof PromptDeliveryManualError) {
      await journal({
        event: "saga_finished",
        state: "manual_intervention_required",
        reason: error.code,
      });
      return;
    }
    if (error instanceof ManagedCreateRetrySameError) {
      // The Host may already own this idempotent create. Preserve its exact
      // Agent registration so the same receipt can resolve it on retry.
      await journal({
        event: "saga_finished",
        state: "failed",
        reason: error.code,
      });
      return;
    }
    if (!(error instanceof SagaStepError)) {
      console.error(`[spawn saga ${receiptId}] unexpected: ${error}`);
      await journal({
        event: "step_failed",
        step: "preflight",
        error: { code: "saga_internal", message: String(error) },
      });
    }
    // ownership-aware compensation: 이번 실행이 만든 산출물만 역순 정리.
    if (owned.length === 0) {
      await journal({ event: "saga_finished", state: "failed" });
      return;
    }
    await journal({ event: "compensation_started" });
    let cleanupFailed = false;
    const rolledBackAgentIds = new Set<string>();
    for (const { artifact: entry, removePane } of [...owned].reverse()) {
      try {
        if (entry.kind === "hmux_session") {
          await hmux.terminateStandalone(entry.id, entry.workspaceId);
        } else if (entry.kind === "pane") {
          const ownedRegistration = createdAgentRegistrations.get(entry.agentId);
          if (ownedRegistration) {
            await rollbackCreatedAgentRegistration(
              ownedRegistration.registration,
              ownedRegistration.launchEvidence,
            );
            rolledBackAgentIds.add(ownedRegistration.registration.id);
          } else {
            removePane?.();
          }
        } else if (entry.kind === "agent_registration") {
          const ownedRegistration = createdAgentRegistrations.get(entry.id);
          if (ownedRegistration && !rolledBackAgentIds.has(entry.id)) {
            await rollbackCreatedAgentRegistration(
              ownedRegistration.registration,
              ownedRegistration.launchEvidence,
            );
            rolledBackAgentIds.add(entry.id);
          }
        }
      } catch (cleanupError) {
        cleanupFailed = true;
        console.error(
          `[spawn saga ${receiptId}] compensation failed for ${entry.kind} ${entry.id}: ${cleanupError}`,
        );
      }
    }
    await journal({ event: "compensation_done" });
    await journal({
      event: "saga_finished",
      state: cleanupFailed ? "manual_intervention_required" : "compensated",
    });
  }
}

function defaultAgentName(
  agents: Agent[],
  project: Project,
  provider: Provider,
) {
  let n = 1;
  const taken = new Set(
    agents
      .filter((agent) => agent.projectId === project.id)
      .map((agent) => agent.name),
  );
  while (taken.has(`${provider}-${n}`)) n++;
  return `${provider}-${n}`;
}

async function resolveSagaPlacement(placement: SagaPlacement) {
  const resolved = await resolvePaneReference(
    placement.referenceSessionId,
    placement.referencePanelId,
  );
  return {
    ...resolved,
    position: {
      referencePanel: resolved.panelId,
      direction: placement.direction,
    },
  };
}

export function artifactIdFromReceipt(
  receipt: SpawnReceipt,
  stepName: string,
  kind: string,
): string | undefined {
  const entry = receipt.steps.find((step) => step.step === stepName);
  const found = entry?.artifacts?.find((candidate) => candidate.kind === kind);
  return typeof found?.id === "string" ? found.id : undefined;
}

interface SagaTools {
  step: <T>(
    name: string,
    run: () => Promise<{ detail?: unknown; value: T }>,
    startedDetail?: unknown,
  ) => Promise<T | undefined>;
  skip: (name: string) => Promise<unknown>;
  artifact: (
    stepName: string,
    created: boolean,
    entry: OwnedArtifact & Record<string, unknown>,
    removePane?: () => boolean,
  ) => Promise<void>;
  journal: (event: Record<string, unknown>) => Promise<void>;
  prior: SpawnReceipt;
  createdAgentRegistrations: Map<string, OwnedAgentRegistration>;
}

/** Execute the adapter selected by the Agent runtime binding. Managed create
 * owns provider launch; capable providers consume the first prompt in that
 * same launch, while older backends and other providers retain Host input. */
async function runAgentRuntime(
  request: SagaRequest,
  project: Project,
  agentName: string,
  placement: Awaited<ReturnType<typeof resolveSagaPlacement>> | undefined,
  tools: SagaTools,
  provisionedWorktree: ProvisionedAgentWorktree | undefined,
  initialExistingWorktreeHandle: ResolvedExistingWorktreeHandle | undefined,
) {
  const {
    step,
    skip,
    artifact,
    journal,
    prior,
    createdAgentRegistrations,
  } = tools;
  const st = useStore.getState();

  let existingWorktreeHandle = initialExistingWorktreeHandle;
  const revalidateExistingWorktree = async () => {
    existingWorktreeHandle = await revalidateExistingWorktreeHandle(
      request,
      project,
      provisionedWorktree,
      existingWorktreeHandle,
    );
  };

  const paneAlreadyCommitted = prior.steps.some(
    (entry) => entry.step === "pane" && entry.status === "ok",
  );
  if (paneAlreadyCommitted) await revalidateExistingWorktree();

  let agent: Agent | undefined = st.agents.find(
    (candidate) => candidate.projectId === project.id && candidate.name === agentName,
  );

  await step("pane", async () => {
    // step_started is durable now; re-observe the exact Git identity and
    // ownership immediately before the first store/pane mutation.
    await revalidateExistingWorktree();
    if (!agent) {
      if (request.useWorktree && !provisionedWorktree) {
        throw new SagaStepError(
          "pane",
          "worktree_artifact_missing",
          "completed worktree step has no durable path and branch",
        );
      }
      // Destructive-boundary rule: the agent identity is journaled BEFORE the
      // store commit, so the journal is the authority a resumed run adopts —
      // a reload between commit and journal can never mint a second agent
      // for one saga. A journaled id whose registration was lost (persist
      // raced the reload) is re-registered under the same id.
      const journaledId = artifactIdFromReceipt(prior, "pane", "agent_registration");
      const agentId = journaledId ?? `agent-${nanoid(8)}`;
      if (!journaledId) {
        await artifact("pane", true, { kind: "agent_registration", id: agentId });
      }
      agent = await addAgent({
        id: agentId,
        projectId: project.id,
        name: agentName,
        provider: request.provider,
        useWorktree: request.useWorktree,
        ...(provisionedWorktree ? { provisionedWorktree } : {}),
        terminalEnv: request.terminalEnv,
        accountId: request.accountId,
        // Registration-level parity with the dialog path: the managed exec
        // step maps permissionMode separately, but the agent record itself
        // must also carry the choice for later ensures/restarts.
        skipPermissions: request.permissionMode === "skip-permissions",
      });
      createdAgentRegistrations.set(agent.id, {
        registration: agent,
        launchEvidence: launchAgentRegistrationEvidence(agent),
      });
    } else {
      await artifact("pane", false, { kind: "agent_registration", id: agent.id });
    }
    if (
      existingWorktreeHandle &&
      agent.worktreePath !== existingWorktreeHandle.reference.canonicalPath
    ) {
      throw new SagaStepError(
        "pane",
        "existing_worktree_agent_cwd_mismatch",
        `agent cwd ${agent.worktreePath} does not match ${existingWorktreeHandle.reference.canonicalPath}`,
      );
    }
    const desktopId = placement?.desktopId ?? request.spaceId ?? st.activeSpaceId;
    const api = placement?.api ?? getDockview(desktopId);
    if (!api) {
      throw new SagaStepError(
        "pane",
        "pane_not_found",
        `desktop ${desktopId} is not mounted`,
      );
    }
    const presentation = presentAgentPanelOnDockview({
      desktopId, api, agent, position: placement?.position,
    });
    if (!presentation) {
      throw new SagaStepError(
        "pane",
        "pane_not_found",
        `desktop ${desktopId} changed before pane commit`,
      );
    }
    const { panel, paneOwnership } = presentation;
    const createdPane = paneOwnership === "created_by_request";
    await artifact(
      "pane",
      createdPane,
      { kind: "pane", id: panel.id, desktopId, agentId: agent.id },
      createdPane ? preparePaneProjectionRemoval(desktopId, api, panel) : undefined,
    );
    return {
      detail: {
        agentId: agent.id,
        desktopId,
        direction: request.placement?.direction,
        runtime: agent.runtimeBinding?.runtime ?? "unbound",
        cwd: agent.worktreePath,
        worktreeDisposition: existingWorktreeHandle?.disposition ?? "created",
      },
      value: undefined,
    };
  });
  if (!agent) throw new SagaStepError("pane", "agent_missing", "agent registration was lost");

  if (agent.runtimeBinding?.runtime === "hmux_managed_v1") {
    await runManagedSteps(request, agent, tools);
  } else {
    // The legacy PTY runtime is retired (2026-08-16). Registration promotes
    // every persisted record onto the managed runtime; reaching this branch
    // means the agent's project is gone — fail visibly instead of spawning a
    // runtime nothing can render.
    const message = `agent ${agent.id} has no managed runtime binding — its project is no longer registered`;
    await journal({
      event: "step_failed",
      step: "runtime_session",
      error: { code: "legacy_runtime_retired", message },
    });
    throw new SagaStepError("runtime_session", "legacy_runtime_retired", message);
  }
  void prior;
  void skip;
  void journal;
}

/** Managed path: the binding-selected adapter owns preflight, idempotent create,
 * and provider launch. The Host create key prevents duplicate lifetimes. */
async function runManagedSteps(
  request: SagaRequest,
  agent: Agent,
  tools: SagaTools,
) {
  const { step, artifact, createdAgentRegistrations } = tools;
  let launched = agent;
  let runtimeConfirmed = false;
  let initialPromptAccepted = tools.prior.steps.some(
    (candidate) =>
      candidate.step === "runtime_session" &&
      candidate.status === "ok" &&
      typeof candidate.detail === "object" &&
      candidate.detail !== null &&
      (candidate.detail as Record<string, unknown>).initialPromptAccepted === true,
  );
  const ensureExactAgent = async (candidate: Agent) => {
    const operation = beginManagedRuntimeEnsure(candidate, {
      columns: 120,
      rows: 30,
      initialPrompt: request.prompt,
    });
    if (!operation) {
      throw new SagaStepError(
        "runtime_session",
        "managed_runtime_binding_missing",
        `agent ${candidate.id} has no managed runtime binding`,
      );
    }
    const receipt = await operation.receipt;
    initialPromptAccepted ||= receipt.initialPromptAccepted === true;
    if (createdAgentRegistrations.has(candidate.id)) {
      createdAgentRegistrations.set(candidate.id, {
        registration: receipt.agent,
        launchEvidence: launchAgentRegistrationEvidence(receipt.agent),
      });
    }
    if (
      request.existingWorktreeRef &&
      receipt.confirmedCwd !== candidate.worktreePath
    ) {
      throw new SagaStepError(
        "runtime_session",
        "existing_worktree_session_cwd_mismatch",
        `managed session cwd ${receipt.confirmedCwd ?? "(unverified)"} does not match ${candidate.worktreePath}`,
      );
    }
    return receipt;
  };

  const admitted = await step("runtime_session", async () => {
    const receipt = await ensureExactAgent(launched);
    // 관리형 세션의 수명은 Host 소유다 — compensation은 pane/등록까지만
    // 정리하고 세션은 발견 가능한 상태로 남긴다(kill API 없음, adopted 의미).
    await artifact("runtime_session", false, {
      kind: "hmux_session",
      id: receipt.sessionId,
      workspaceId: receipt.workspaceId,
    });
    return {
      detail: {
        sessionId: receipt.sessionId,
        workspaceId: receipt.workspaceId,
        idempotencyKey: receipt.idempotencyKey,
        cwd: receipt.confirmedCwd,
        initialPromptAccepted: receipt.initialPromptAccepted || undefined,
      },
      value: receipt.agent,
    };
  });
  if (admitted) {
    launched = admitted;
    runtimeConfirmed = true;
  }

  await step("provider_exec", async () => {
    // 관리형 create가 provider 명령을 Host에서 직접 실행한다. 요청 permissionMode와
    // 실제 적용값(store.skipPermissions 기반)을 모두 기록한다 (UC-03 AC).
    const applied = useStore.getState().skipPermissions[launched.provider]
      ? "bypass_approvals"
      : "default";
    const requested =
      request.permissionMode === "skip-permissions" ? "bypass_approvals" : "default";
    return {
      detail: {
        launchedBy: "hmux_managed_create",
        permissionModeRequested: requested,
        permissionModeApplied: applied,
        mismatch: requested !== applied || undefined,
      },
      value: undefined,
    };
  });

  if (initialPromptAccepted) {
    await executeLaunchPromptDelivery(request.prompt, tools);
    return;
  }

  let promptRuntimeFailure:
    | { code: string; message: string; deliveryState: "not_written" }
    | undefined;
  if (request.prompt && !runtimeConfirmed) {
    const current =
      useStore
        .getState()
        .agents.find((candidate) => candidate.id === launched.id) ?? launched;
    try {
      const receipt = await ensureExactAgent(current);
      launched = receipt.agent;
      runtimeConfirmed = true;
    } catch (error) {
      promptRuntimeFailure = {
        code:
          error instanceof ManagedAgentInputError
            ? error.code
            : "managed_runtime_unavailable",
        message: error instanceof Error ? error.message : String(error),
        deliveryState: "not_written",
      };
    }
  }

  await executePromptDelivery(request.prompt, tools, async (prompt) => {
    if (promptRuntimeFailure) {
      return { state: "failed", error: promptRuntimeFailure };
    }
    if (!runtimeConfirmed) {
      const current =
        useStore
          .getState()
          .agents.find((candidate) => candidate.id === launched.id) ?? launched;
      try {
        const receipt = await ensureExactAgent(current);
        launched = receipt.agent;
        runtimeConfirmed = true;
      } catch (error) {
        return {
          state: "failed",
          error: {
            code:
              error instanceof ManagedAgentInputError
                ? error.code
                : "managed_runtime_unavailable",
            message: error instanceof Error ? error.message : String(error),
            deliveryState: "not_written",
          },
        };
      }
    }
    try {
      const receipt = await sendHmuxInitialAgentPrompt(launched, prompt);
      return { state: "written", receipt };
    } catch (error) {
      if (error instanceof ManagedAgentInputError) {
        return {
          state: "failed",
          error: {
            code: error.code,
            message: error.message,
            deliveryState:
              error.deliveryState === "not_written" ? "not_written" : "unknown",
          },
        };
      }
      throw error;
    }
  });
}
