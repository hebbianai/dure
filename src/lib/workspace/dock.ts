import { withAgentChatDraftMoves } from "@/lib/agents/chat/agentChatDraftMoveCoordinator";
import { publishLayoutPush } from "@/lib/workspace/layout/layoutPushChannel";
import type { DockviewApi } from "dockview-react";
import { nanoid } from "nanoid";
import {
  dockPanelParameters,
  dockPanelReference,
  findTerminalPanel,
} from "@/lib/workspace/dock/dockPanelParameters";
import { agentIdFromPaneParameters } from "@/lib/workspace/layout/agentPaneParameters";
import {
  panelDefinitionFromLayout,
  panelsFromLayout,
  type SerializedPanelRef,
} from "@/lib/workspace/layout/layoutLifecycle";
import { sessionIdForPane } from "@/lib/workspace/layout/paneSessionReference";
import {
  openRemoteHmuxTerminal,
  openRemoteHmuxTerminalDetached,
} from "@/lib/hmux/remote/remoteHmuxTerminalSession";
import { t } from "@/lib/i18n";
import { errorMessage } from "@/lib/payloadGuards";
import { showErrorToast } from "@/lib/toast";
import {
  createStandaloneOnce,
  hmuxManagedShellReady,
  hmuxStandaloneReady,
} from "@/lib/hmux/standalone/hmuxStandaloneRollout";
import { useStore } from "@/store";
import type { Agent } from "@/types";
import {
  hmuxLocalBinding,
  hmuxManagedBinding,
  hmuxStandaloneBinding,
  type TerminalPaneBindingV1,
} from "@/lib/terminal/terminalBinding";
import {
  moveFailure,
  planDesktopPaneMove,
  snapshotAffectedLayouts,
  type DesktopPaneMoveItem,
  type DesktopPaneMovePlan,
  type MovePanelsToDesktopReceipt,
} from "@/lib/workspace/desktop/desktopPaneMove";
import {
  dockviewRegistry as registry,
  movingPanels,
} from "@/lib/workspace/dock/dockRegistry";
import { requestDesktopPrewarm } from "@/lib/workspace/desktop/desktopPrewarm";
import { enqueuePaneMove } from "@/lib/workspace/pane/paneMoveQueue";
import {
  paneSplitTargetForPanel,
} from "@/lib/workspace/pane/paneSplitFromParams";
import type { PaneSplitPaneParams } from "@/lib/workspace/pane/paneSplitTarget";
import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import { retargetMovedHiddenPanes } from "@/lib/workspace/pane/paneVisibility";
import {
  createHmuxManagedShellTerminalOn,
  openHmuxManagedTerminalOn,
} from "@/lib/sessions/managed/managedShellTerminal";
import { getDragState, setDragState } from "@/lib/workspace/pane/paneDragState";
import { openAgentPanelOnDockview } from "@/lib/workspace/dock/openAgentPanel";
import { registeredDesktopIdFor } from "@/lib/workspace/dock/dockRegistry";
import { autoSplitPosition, rightRailPosition } from "@/lib/workspace/dock/gridPanePlacement";
import { createHmuxStandaloneTerminalOn } from "@/lib/workspace/dock/standaloneShellTerminal";
import { addPanePreservingSizes } from "@/lib/workspace/pane/paneMutationSizing";
import { createPaneId } from "@/lib/workspace/pane/paneIdentity";
import { placementOptions } from "@/lib/workspace/pane/panePlacement";

// Temporary re-exports for src/components/settings/AccountsPage.tsx only
// (another agent owns settings/** right now). Every other consumer imports
// these from their defining modules; drop these once AccountsPage follows.

export type PaneSplitDirection = "right" | "below";

export interface CreateTerminalPaneRequest {
  referenceSessionId: string;
  referencePanelId?: string;
  direction: PaneSplitDirection;
  cwd?: string;
}

export interface CreateTerminalPaneReceipt {
  desktopId: string;
  referencePanelId: string;
  panelId: string;
  sessionId: string;
  runtime: "hmux_session_v1" | "hmux_standalone_v1" | "hmux_managed_v1";
  source: "local" | "ssh";
  hostId: string;
  binding: TerminalPaneBindingV1;
  direction: PaneSplitDirection;
  cwd?: string;
}

interface PaneMatch {
  desktopId: string;
  api: DockviewApi;
  panel: DockviewApi["panels"][number];
}

type PaneReference = string | { agentId: string };

function matchesPaneReference(
  pane: SerializedPanelRef,
  reference: PaneReference,
  agents: readonly Agent[],
): boolean {
  return typeof reference === "string"
    ? sessionIdForPane(pane, agents) === reference
    : pane.component === "agent" &&
      agentIdFromPaneParameters(pane.params) === reference.agentId;
}

function paneReferenceLabel(reference: PaneReference): string {
  return typeof reference === "string"
    ? `session ${reference}`
    : `agent ${reference.agentId}`;
}

function isLivePanel(api: DockviewApi, panel: DockviewApi["panels"][number]): boolean {
  return (
    api.getPanel(panel.id) === panel &&
    api.groups.includes(panel.group) &&
    panel.group.element.isConnected
  );
}

function findMountedPanelById(panelId: string): PaneMatch[] {
  const matches: PaneMatch[] = [];
  for (const [desktopId, api] of registry) {
    const panel = api.getPanel(panelId);
    if (panel && isLivePanel(api, panel)) {
      matches.push({ desktopId, api, panel });
    }
  }
  return matches;
}

function findMountedPaneMatches(
  reference: PaneReference,
  referencePanelId?: string,
): PaneMatch[] {
  const matches: PaneMatch[] = [];
  const { agents } = useStore.getState();
  for (const [desktopId, api] of registry) {
    for (const panel of api.panels) {
      if (!isLivePanel(api, panel)) continue;
      if (referencePanelId && panel.id !== referencePanelId) continue;
      if (matchesPaneReference(dockPanelReference(panel), reference, agents)) {
        matches.push({ desktopId, api, panel });
      }
    }
  }
  return matches;
}

async function preparePersistedPaneDesktop(
  reference: PaneReference,
  referencePanelId?: string,
): Promise<void> {
  const state = useStore.getState();
  const desktopIds = Object.entries(state.layouts)
    .filter(([, layout]) =>
      panelsFromLayout(layout).some((pane) =>
        (!referencePanelId || pane.id === referencePanelId) &&
        matchesPaneReference(pane, reference, state.agents),
      ),
    )
    .map(([desktopId]) => desktopId);

  if (desktopIds.length === 0) return;
  if (desktopIds.length > 1) {
    throw new PaneCommandError(
      "pane_ambiguous",
      `${paneReferenceLabel(reference)} is persisted in ${desktopIds.length} spaces`,
    );
  }

  const [desktopId] = desktopIds;
  requestDesktopPrewarm(desktopId);
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    if (
      findMountedPaneMatches(reference, referencePanelId).some(
        (match) => match.desktopId === desktopId,
      )
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function preparePersistedPanelDesktop(panelId: string): Promise<void> {
  const state = useStore.getState();
  const desktopIds = Object.entries(state.layouts)
    .filter(([, layout]) => panelDefinitionFromLayout(layout, panelId) !== undefined)
    .map(([desktopId]) => desktopId);
  if (desktopIds.length === 0) return;
  if (desktopIds.length > 1) {
    throw new PaneCommandError(
      "pane_ambiguous",
      `pane ${panelId} is persisted in ${desktopIds.length} spaces`,
    );
  }

  const [desktopId] = desktopIds;
  requestDesktopPrewarm(desktopId);
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    if (findMountedPanelById(panelId).some((match) => match.desktopId === desktopId)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function resolveReferencedPane(
  reference: PaneReference,
  referencePanelId?: string,
): Promise<PaneMatch> {
  let matches = findMountedPaneMatches(reference, referencePanelId);
  if (matches.length === 0) {
    await preparePersistedPaneDesktop(reference, referencePanelId);
    matches = findMountedPaneMatches(reference, referencePanelId);
  }

  if (matches.length === 0) {
    throw new PaneCommandError(
      "pane_not_found",
      `no pane owns ${paneReferenceLabel(reference)}`,
    );
  }
  if (matches.length > 1) {
    throw new PaneCommandError(
      "pane_ambiguous",
      `${paneReferenceLabel(reference)} is visible in ${matches.length} panes`,
    );
  }

  return matches[0];
}

/**
 * Resolve one pane by terminal session and split relative to it. A pane on an
 * inactive desktop is prepared without changing visible selection; persisted
 * layout is only used for exact discovery and is never edited directly.
 */
export async function createTerminalPaneRelativeToSession(
  request: CreateTerminalPaneRequest,
  claim?: () => Promise<boolean>,
): Promise<CreateTerminalPaneReceipt> {
  const referenceSessionId = request.referenceSessionId.trim();
  const referencePanelId = request.referencePanelId?.trim() || undefined;
  if (!referenceSessionId || !["right", "below"].includes(request.direction)) {
    throw new PaneCommandError(
      "invalid_request",
      "referenceSessionId and direction (right|below) are required",
    );
  }
  const { desktopId, api, panel } = await resolveReferencedPane(
    referenceSessionId,
    referencePanelId,
  );
  if (claim && !(await claim())) {
    throw new PaneCommandError("request_expired", "pane request expired before mutation");
  }
  const livePanel = api.getPanel(panel.id);
  if (!livePanel || !isLivePanel(api, livePanel)) {
    throw new PaneCommandError(
      "pane_not_found",
      `pane for session ${referenceSessionId} detached before mutation`,
    );
  }

  const currentState = useStore.getState();
  const pane = dockPanelReference(livePanel);
  if (
    livePanel !== panel ||
    sessionIdForPane(pane, currentState.agents) !== referenceSessionId
  ) {
    throw new PaneCommandError("pane_changed", "the reference pane changed before creation");
  }
  const params = pane.params as PaneSplitPaneParams;
  // Use the same split-location owner as the UI, with only the current
  // content's inputs. A matching session does not make a terminal an Agent.
  const target = paneSplitTargetForPanel(pane, params);
  const cwd = request.cwd?.trim() || target.cwd;

  const position = {
    referencePanel: livePanel.id,
    direction: request.direction,
  } as const;
  if (target.kind === "ssh") {
    const host = currentState.sshHosts.find(
      (candidate) => candidate.id === target.hostId,
    );
    if (!host) {
      throw new PaneCommandError(
        "invalid_request",
        `SSH host ${target.hostId} is unavailable`,
      );
    }
    const remote = await openRemoteHmuxTerminal({
      api,
      desktopId,
      hostId: host.id,
      hostName: host.name,
      cwd,
      position,
    });
    return {
      desktopId,
      referencePanelId: panel.id,
      panelId: remote.panelId,
      sessionId: remote.sessionId,
      runtime: remote.binding.runtime,
      source: "ssh",
      hostId: host.id,
      binding: remote.binding,
      direction: request.direction,
      cwd,
    };
  }
  const local = await createLocalTerminalForReceipt(
    api,
    cwd,
    position,
    desktopId,
    `term-${nanoid(8)}`,
  );
  return {
    desktopId,
    referencePanelId: panel.id,
    panelId: local.panelId,
    sessionId: local.sessionId,
    runtime: local.binding.runtime,
    source: "local",
    hostId: "local",
    binding: local.binding,
    direction: request.direction,
    cwd,
  };
}

/** Awaited local terminal creation for callers that must report the real
 * outcome (CLI receipts). Same managed-first/standalone-fallback ladder as
 * openLocalTerminalOn, but the created identity and binding come back
 * instead of a fire-and-forget guess — the receipt never lies about the
 * runtime any more. */
async function createLocalTerminalForReceipt(
  api: DockviewApi,
  cwd: string | undefined,
  position: PanelPosition,
  desktopId: string,
  requestedSessionId: string,
): Promise<{
  sessionId: string;
  panelId: string;
  binding: TerminalPaneBindingV1;
}> {
  if (await hmuxManagedShellReady()) {
    try {
      const created = await createHmuxManagedShellTerminalOn(
        api,
        cwd,
        position,
        undefined,
        desktopId,
        requestedSessionId,
      );
      const binding = {
        ...hmuxManagedBinding(
          created.session.sessionId,
          created.session.workspaceId,
        ),
        createIdempotencyKey: created.idempotencyKey,
        ...(created.session.stopFence
          ? { stopFence: created.session.stopFence }
          : {}),
      };
      return {
        sessionId: created.session.sessionId,
        panelId: created.panelId,
        binding,
      };
    } catch (error) {
      console.warn(`[hmux managed shell] ${String(error)}`);
    }
  }
  if (!(await hmuxStandaloneReady())) {
    throw new PaneCommandError(
      "invalid_request",
      "structured terminal backend is unavailable",
    );
  }
  const created = await createHmuxStandaloneTerminalOn(
    api,
    cwd,
    position,
    undefined,
    desktopId,
    { operationId: requestedSessionId },
  );
  return {
    sessionId: created.sessionId,
    panelId: created.panelId,
    binding: hmuxStandaloneBinding(created.sessionId, created.workspaceId),
  };
}

// ---------- 데스크탑 간 패널 이동 (탭을 하단 데스크탑 탭으로 드래그) ----------

async function executePanelMove(
  items: readonly DesktopPaneMoveItem[],
  targetDesktopId: string,
): Promise<MovePanelsToDesktopReceipt> {
  return withAgentChatDraftMoves(items, targetDesktopId, () => {
  const snapshot = snapshotAffectedLayouts(
    useStore.getState().layouts,
    items,
    targetDesktopId,
    registry,
  );
  if ("errorDesktopId" in snapshot) {
    return moveFailure("layout_snapshot_failed", snapshot.errorDesktopId);
  }
  const plan = planDesktopPaneMove(
    snapshot.layouts,
    items,
    targetDesktopId,
  );
  return commitDesktopPaneMove(plan, targetDesktopId);
  });
}

/** Commit a freshly planned move without an intervening await. Ordinary moves
 * and popout share this layout writer, removal guard and projection order. */
export function commitDesktopPaneMove(
  plan: DesktopPaneMovePlan,
  targetDesktopId: string,
): MovePanelsToDesktopReceipt {
  if (plan.error || plan.movedPanelIds.length === 0) {
    return {
      ...plan,
      projectedDesktopIds: [],
      projectionFailedDesktopIds: [],
    };
  }

  useStore.setState((state) => ({
    layouts: { ...state.layouts, ...plan.updates },
  }));

  const projectedDesktopIds: string[] = [];
  const projectionFailedDesktopIds: string[] = [];
  const guardedPanelIds = new Set(plan.movedPanelIds);
  for (const panelId of guardedPanelIds) movingPanels.add(panelId);
  try {
    const projectionOrder = [
      ...plan.touchedDesktopIds.filter(
        (desktopId) => desktopId !== targetDesktopId,
      ),
      ...(plan.touchedDesktopIds.includes(targetDesktopId)
        ? [targetDesktopId]
        : []),
    ];
    for (const desktopId of projectionOrder) {
      const api = registry.get(desktopId);
      const layout = plan.updates[desktopId];
      if (!api || !layout) continue;
      try {
        api.fromJSON(
          layout as Parameters<DockviewApi["fromJSON"]>[0],
          { reuseExistingPanels: true },
        );
        projectedDesktopIds.push(desktopId);
      } catch (error) {
        projectionFailedDesktopIds.push(desktopId);
        console.error(`[pane move projection:${desktopId}]`, error);
      }
    }
  } finally {
    // Dockview may deliver a removal callback at the end of the current task.
    setTimeout(() => {
      for (const panelId of guardedPanelIds) movingPanels.delete(panelId);
    }, 0);
  }

  // 다른 창에 mount된 데스크탑은 여기서 projection되지 않는다 — 그 창이
  // 포커스 게이트와 무관하게 반영하도록 명시적 push를 알린다 (자기 창은
  // storage 이벤트를 받지 않으므로 전체 touched를 그대로 보내면 된다).
  publishLayoutPush(plan.touchedDesktopIds);

  return retargetMovedHiddenPanes({
    ...plan,
    projectedDesktopIds,
    projectionFailedDesktopIds,
  }, targetDesktopId, useStore.getState().layouts[targetDesktopId]);
}

/** 드래그 중이던 패널을 targetDesktop으로 옮긴다. */
export function movePanelToDesktop(targetDesktopId: string) {
  const s = getDragState();
  setDragState(null);
  if (!s || s.fromDesktopId === targetDesktopId) return;
  void movePanelsToDesktop([s], targetDesktopId);
}

/**
 * 여러 패널을 targetDesktop으로 옮긴다. Persisted layouts가 원본 진실이며
 * source 제거+target 추가를 한 Zustand persist commit으로 쓴 뒤, mounted
 * Dockview는 그 결과를 projection한다. 미마운트·백그라운드 데스크탑도 같은
 * 경로를 쓰고 같은 창의 동시 move는 직렬화한다.
 */
export function movePanelsToDesktop(
  items: readonly DesktopPaneMoveItem[],
  targetDesktopId: string,
): Promise<MovePanelsToDesktopReceipt> {
  return enqueuePaneMove(() => executePanelMove(items, targetDesktopId))
    .catch((error) => {
      console.error(`[pane move:${targetDesktopId}]`, error);
      return moveFailure("move_execution_failed", targetDesktopId);
    });
}

import type { PanelPosition } from "@/lib/workspace/pane/panePlacement";

/** Resolve one pane by durable Dockview identity without assuming which
 * terminal session it currently consumes. Transactional handoffs use this to
 * recover when the pane and Agent records are on opposite sides of a CAS. */
export async function resolvePaneById(
  referencePanelId: string,
): Promise<{ desktopId: string; api: DockviewApi; panelId: string; cwd?: string }> {
  const panelId = referencePanelId.trim();
  if (!panelId) {
    throw new PaneCommandError("invalid_request", "targetPanelId is invalid");
  }
  let matches = findMountedPanelById(panelId);
  if (matches.length === 0) {
    await preparePersistedPanelDesktop(panelId);
    matches = findMountedPanelById(panelId);
  }
  if (matches.length === 0) {
    throw new PaneCommandError("pane_not_found", `pane ${panelId} was not found`);
  }
  if (matches.length > 1) {
    throw new PaneCommandError(
      "pane_ambiguous",
      `pane ${panelId} is visible in ${matches.length} spaces`,
    );
  }
  const [{ desktopId, api, panel }] = matches;
  const params = dockPanelParameters(panel) as { cwd?: string };
  return { desktopId, api, panelId: panel.id, cwd: params.cwd };
}

/** Resolve a session or Agent presentation without changing visible selection.
 * Agent queries follow explicit content references across runtime replacements. */
export async function resolvePaneReference(
  reference: PaneReference,
  referencePanelId?: string,
): Promise<{ desktopId: string; api: DockviewApi; panelId: string; cwd?: string }> {
  const normalized = typeof reference === "string"
    ? reference.trim()
    : { agentId: reference.agentId.trim() };
  if (typeof normalized === "string" ? !normalized : !normalized.agentId) {
    throw new PaneCommandError(
      "invalid_request",
      typeof normalized === "string" ? "referenceSessionId is required" : "agentId is required",
    );
  }
  const sessionId = typeof normalized === "string" ? normalized : undefined;
  const panelId = referencePanelId?.trim() || undefined;
  const { desktopId, api, panel } = await resolveReferencedPane(normalized, panelId);
  const { component, params } = dockPanelReference(panel);
  const state = useStore.getState();
  const agentId = component === "agent"
    ? agentIdFromPaneParameters(params)
    : undefined;
  const agent = state.agents.find((candidate) => candidate.id === agentId);
  const paneCwd = component === "agent" ? agent?.worktreePath : params.cwd;
  const cwd =
    (sessionId ? state.sessionCwd[sessionId] : undefined) ||
    (typeof paneCwd === "string" ? paneCwd : undefined);
  return { desktopId, api, panelId: panel.id, cwd };
}

// dockview grid 직렬화 노드(부분). leaf = 한 그룹, views = 그 그룹에 쌓인 패널들.
interface GridLeaf {
  type: "leaf";
  data: { views: string[]; activeView?: string; id: string };
  size?: number;
}
interface GridBranch {
  type: "branch";
  data: GridNode[];
  size?: number;
}
type GridNode = GridLeaf | GridBranch;

/** 저장된 레이아웃에서 한 그룹에 여러 패널이 쌓인 것을 각각 별도 그룹으로 분리한다
 *  (그리드식 "한 패널당 한 pane"). 순수 JSON 변환이라 라이브 세션을 건드리지 않고,
 *  스택이 없거나 오류면 원본을 그대로 반환한다. multi-view leaf를 single-view leaf
 *  들의 branch로 치환하고 그룹 id를 새로 매긴다(참조 깨지는 activeGroup은 제거). */
export function ungroupStackedLayout(layout: unknown): unknown {
  try {
    const root = (layout as { grid?: { root?: GridNode } })?.grid?.root;
    if (!root) return layout;
    let hasStack = false;
    const scan = (n: GridNode) => {
      if (n.type === "leaf") {
        if ((n.data?.views?.length ?? 0) > 1) hasStack = true;
      } else n.data?.forEach(scan);
    };
    scan(root);
    if (!hasStack) return layout; // 분리할 게 없으면 그대로 (id 재매김 churn 방지)

    const l = JSON.parse(JSON.stringify(layout)) as { grid: { root: GridNode }; activeGroup?: string };
    let counter = 1;
    const nextId = () => String(counter++);
    const walk = (node: GridNode): GridNode => {
      if (node.type === "leaf") {
        const views = node.data?.views ?? [];
        if (views.length <= 1) {
          if (node.data) node.data.id = nextId();
          return node;
        }
        const size = node.size;
        const each = size ? Math.max(1, Math.floor(size / views.length)) : undefined;
        return {
          type: "branch",
          data: views.map((v) => ({
            type: "leaf" as const,
            data: { views: [v], activeView: v, id: nextId() },
            ...(each ? { size: each } : {}),
          })),
          ...(size ? { size } : {}),
        };
      }
      node.data = node.data.map(walk);
      return node;
    };
    l.grid.root = walk(l.grid.root);
    delete l.activeGroup; // 그룹 id를 새로 매겨 참조가 깨지므로 제거
    return l;
  } catch {
    return layout;
  }
}

export function openAgentPanel(
  desktopId: string,
  agent: Agent,
  position?: PanelPosition,
): string | false {
  const api = registry.get(desktopId);
  return api
    ? openAgentPanelOnDockview({ desktopId, api, agent, position })
    : false;
}

export function openLocalTerminalPanel(desktopId: string, cwd?: string, position?: PanelPosition) {
  const api = registry.get(desktopId);
  if (api) openLocalTerminalOn(api, cwd, position);
}


/** 비활성(언마운트) 데스크탑을 대상으로 pane을 열 때: 그 데스크탑을 활성화하고
 *  DockView가 마운트되면 액션을 실행한다. "X 데스크탑에 추가"는 결과를 보여야
 *  하므로 전환이 곧 UX다 (navigateToPanel과 같은 계약). ~5초 내 마운트가 안
 *  되면 조용히 포기한다 (데스크탑 삭제 등). */
export function withDesktopDockview(
  desktopId: string,
  action: (api: DockviewApi) => void,
): void {
  // 삭제된 데스크탑이면 activeSpaceId를 유령 id로 만들지 않는다
  // (다이얼로그가 열려 있는 사이 데스크탑이 지워질 수 있다).
  if (!useStore.getState().spaces.some((desktop) => desktop.id === desktopId)) return;
  if (useStore.getState().activeSpaceId !== desktopId) {
    useStore.getState().setActiveSpace(desktopId);
  }
  const run = (attempt: number) => {
    const api = registry.get(desktopId);
    if (api) {
      action(api);
      return;
    }
    if (attempt >= 25) return;
    setTimeout(() => run(attempt + 1), 200);
  };
  run(0);
}

/** Wait for a newly-created desktop to publish its live Dockview registry. */
/** 데스크탑을 활성화하고 마운트를 기다렸다가 에이전트 pane을 연다. */
export function openAgentPanelOnDesktop(desktopId: string, agent: Agent): void {
  withDesktopDockview(desktopId, () => openAgentPanel(desktopId, agent));
}

/** 데스크탑을 활성화하고 마운트를 기다렸다가 로컬 터미널을 연다. */
export function openTerminalPanelOnDesktop(desktopId: string, cwd?: string): void {
  withDesktopDockview(desktopId, (api) => {
    openLocalTerminalOn(api, cwd);
  });
}

/** Remote hmux shell pane on an already-registered dockview — the only ssh
 * shell path for splits/inherited opens. No legacy fallback: a host without
 * hmux fails visibly (remoteHmuxTerminalSession header owns that policy). */
export function openRemoteSshTerminalOn(
  api: DockviewApi,
  hostId: string,
  hostName: string,
  cwd?: string,
  position?: PanelPosition,
  extras?: { commandLine?: string; title?: string },
): Promise<void> {
  const desktopId = registeredDesktopIdFor(api);
  if (!desktopId) {
    console.error(
      "[ssh terminal] dockview is not registered to a desktop — cannot prove remote pane ownership",
    );
    return Promise.resolve();
  }
  return openRemoteHmuxTerminalDetached({
    api,
    desktopId,
    hostId,
    hostName,
    cwd,
    position,
    ...(extras?.commandLine ? { commandLine: extras.commandLine } : {}),
    ...(extras?.title ? { title: extras.title } : {}),
  });
}

/** 데스크탑을 활성화하고 마운트를 기다렸다가 SSH 원격 터미널을 연다. */
export function openSshTerminalPanelOnDesktop(
  desktopId: string,
  hostId: string,
  hostName: string,
  cwd?: string,
): void {
  withDesktopDockview(desktopId, (api) => {
    openRemoteHmuxTerminalDetached({ api, desktopId, hostId, hostName, cwd });
  });
}

export function openHmuxTerminalPanel(
  desktopId: string,
  sessionId: string,
  workspaceId: string,
  cwd?: string,
  position?: PanelPosition,
): string | undefined {
  const api = registry.get(desktopId);
  return api ? openHmuxTerminalOn(api, sessionId, workspaceId, cwd, position) : undefined;
}

export function openHmuxManagedTerminalPanel(
  desktopId: string,
  sessionId: string,
  workspaceId: string,
  cwd: string,
  position?: PanelPosition,
): string | undefined {
  const api = registry.get(desktopId);
  return api
    ? openHmuxManagedTerminalOn(api, sessionId, workspaceId, cwd, position).id
    : undefined;
}

/** The reserved intent identifies the same native creation across retries and
 * StrictMode remounts; terminal creation never falls back to a raw PTY. */
export function openLocalTerminalOn(
  api: DockviewApi,
  cwd?: string,
  position?: PanelPosition,
  sessionId: string = `term-${nanoid(8)}`,
): string {
  void createLocalTerminalOn(api, cwd, position, sessionId);
  return sessionId;
}

/** The launcher awaits the same creation and error reporting as detached opens. */
export function createLocalTerminalOn(
  api: DockviewApi,
  cwd?: string,
  position?: PanelPosition,
  sessionId: string = `term-${nanoid(8)}`,
): Promise<void> {
  const desktopId = registeredDesktopIdFor(api);
  const targetPosition = position ?? rightRailPosition(api);
  return createStandaloneOnce(sessionId, async () => {
    const failures: string[] = [];
    try {
      if (await hmuxManagedShellReady()) {
        try {
          await createHmuxManagedShellTerminalOn(
            api,
            cwd,
            targetPosition,
            undefined,
            desktopId,
            sessionId,
          );
          return;
        } catch (error) {
          failures.push(errorMessage(error));
          console.warn(`[hmux managed shell] ${errorMessage(error)}`);
        }
      }
      if (!await hmuxStandaloneReady()) {
        throw new Error(t("terminal.failure.unavailable"));
      }
      await createHmuxStandaloneTerminalOn(
        api,
        cwd,
        targetPosition,
        undefined,
        desktopId,
        { operationId: sessionId },
      );
    } catch (error) {
      failures.push(errorMessage(error));
      const detail = failures.join("; ");
      console.error(`[local terminal] ${detail}`);
      showErrorToast(t("terminal.failure.create", { detail }));
      // Reject the owned creation so failure is not cached as a successful
      // pane. Coalesced callers share this one persistent error notice.
      throw new Error(detail);
    }
  }).catch(() => undefined);
}

/** Explicit read-only Hmux observer. Existing local panes stay on their legacy
 * binding; callers must opt into a discoverable session and workspace. */
export function openHmuxTerminalOn(
  api: DockviewApi,
  sessionId: string,
  workspaceId: string,
  cwd?: string,
  position?: PanelPosition,
): string {
  const binding = hmuxLocalBinding(sessionId, workspaceId);
  const existing = findTerminalPanel(api, binding);
  if (existing) {
    existing.api.setActive();
    return existing.id;
  }
  return addPanePreservingSizes(api, {
    id: position?.replacement?.id ?? createPaneId(),
    component: "terminal",
    title: t("common.terminal"),
    params: {
      sessionId,
      cwd,
      binding,
    },
    ...placementOptions(position ?? autoSplitPosition(api)),
  }).id;
}


/** 이 데스크탑은 빈 채로 연다 — 이름만 정하고 무엇을 띄울지는 사용자가 고르는
 *  흐름(DesktopBar '+')이 표시한다. 표시가 없으면 Workspace onReady가 focusCtx
 *  상속으로 기본 터미널을 연다. */
const desktopsStartingEmpty = new Set<string>();
export function markDesktopStartsEmpty(desktopId: string) {
  desktopsStartingEmpty.add(desktopId);
  // 이중 마운트(StrictMode)가 모두 같은 표시를 읽어야 하므로 즉시 지우지 않고,
  // 마운트가 모두 정착한 뒤 자동 만료시킨다.
  setTimeout(() => desktopsStartingEmpty.delete(desktopId), 5000);
}

/** 빈 채로 열기로 표시되지 않은 데스크탑의 첫 터미널을 focusCtx 상속으로 연다.
 *  세션 id는 데스크탑별로 결정적이라 StrictMode 이중 마운트가 같은 세션으로
 *  합쳐진다(표시를 지우지 않고 읽는(peek) 것과 짝을 이룬다). */
/** Remote creation is not idempotent (each call plans a fresh session id), so
 * a StrictMode double mount would open two remote shells. The deterministic
 * `term-${desktopId}` trick that merges local double mounts cannot apply —
 * absorb the second mount with a short-lived per-desktop guard instead. */
const remoteInitialTerminalPending = new Set<string>();

function openDesktopInitialRemoteTerminal(
  desktopId: string,
  api: DockviewApi,
  hostId: string,
  hostName: string,
  cwd?: string,
): void {
  if (remoteInitialTerminalPending.has(desktopId)) return;
  remoteInitialTerminalPending.add(desktopId);
  setTimeout(() => remoteInitialTerminalPending.delete(desktopId), 5000);
  openRemoteHmuxTerminalDetached({ api, desktopId, hostId, hostName, cwd });
}

export function openDesktopInitialTerminal(desktopId: string, api: DockviewApi) {
  // peek (삭제하지 않음) — StrictMode 이중 마운트가 둘 다 같은 답을 봐야 한다.
  if (desktopsStartingEmpty.has(desktopId)) return;
  const termSid = `term-${desktopId}`;
  // focusCtx 상속 (SSH 호스트에 있었으면 그 호스트로)
  const st = useStore.getState();
  const fc = st.focusCtx;
  if (fc?.source === "ssh" && fc.hostId) {
    const host = st.sshHosts.find((h) => h.id === fc.hostId);
    if (host) {
      openDesktopInitialRemoteTerminal(desktopId, api, fc.hostId, host.name, fc.cwd);
      return;
    }
  }
  openLocalTerminalOn(api, fc?.source === "local" ? fc.cwd : undefined, undefined, termSid);
}

/** 마지막 포커스 컨텍스트(focusCtx)를 상속해 터미널을 연다. SSH 호스트 pane에
 *  있었으면 같은 호스트 셸로, 로컬이면 로컬 셸로. 새 데스크탑/"새로"에서 사용. */
export function openInheritedTerminalOn(api: DockviewApi, position?: PanelPosition) {
  const st = useStore.getState();
  const fc = st.focusCtx;
  if (fc?.source === "ssh" && fc.hostId) {
    const host = st.sshHosts.find((h) => h.id === fc.hostId);
    if (host) {
      openRemoteSshTerminalOn(api, fc.hostId, host.name, fc.cwd, position);
      return;
    }
  }
  openLocalTerminalOn(api, fc?.source === "local" ? fc.cwd : undefined, position);
}

/** desktopId 기준으로 focusCtx를 상속해 터미널을 연다. */
export function openInheritedTerminalPanel(desktopId: string, position?: PanelPosition) {
  const api = registry.get(desktopId);
  if (api) openInheritedTerminalOn(api, position);
}

/** SSH 호스트 하나를 연다 — **그 서버의 hmux 세션으로**. 실패는 토스트가 말한다.
 *  legacy PTY 로 되돌아가지 않는 이유는 `remoteHmuxTerminalSession` 머리말에. */
export function openSshTerminalPanel(
  desktopId: string,
  hostId: string,
  hostName: string,
  position?: PanelPosition,
  cwd?: string,
) {
  const api = registry.get(desktopId);
  if (!api) return;
  openRemoteHmuxTerminalDetached({ api, desktopId, hostId, hostName, cwd, position });
}
