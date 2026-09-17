import { emit } from "@tauri-apps/api/event";
import type { IDockviewPanel } from "dockview-react";
import { subscribeDockviewRegistration } from "@/lib/workspace/dock/dockviewRegistration";
import { resolvePaneById } from "@/lib/workspace/dock";
import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import { mountedDockviewEntries } from "@/lib/workspace/dock/dockRegistry";
import { dockPanelParameters } from "@/lib/workspace/dock/dockPanelParameters";
import { commitExplicitDockviewMutation } from "@/lib/workspace/dock/explicitDockviewCommit";
import { querySessionHmux, type HmuxSessionSummary } from "@/lib/ipc";
import { inspectHmuxSessionExact } from "@/lib/hmux/identity/exactHmuxSessionInspection";
import { isWritableHealthyStandaloneReplacement } from "@/lib/hmux/standalone/hmuxRecoveryReplacement";
import { panelsFromLayout } from "@/lib/workspace/layout/layoutLifecycle";
import {
  hmuxStandaloneBinding,
  type HmuxStandalonePaneBindingV1,
} from "@/lib/terminal/terminalBinding";
import { useStore } from "@/store";
import {
  nonEmptyString,
  durableStandaloneHmuxRetargets,
  projectStandaloneHmuxAttachParams,
  projectStandaloneHmuxConsumerParams,
  projectStandaloneHmuxLayouts,
  sameStandaloneHmuxIdentity,
  sortedStandaloneHmuxConsumers,
  sourceStandaloneBindingFromHandoff,
  sourceTransportSessionFromHandoff,
  standaloneTerminalBinding,
  validStandaloneHmuxRetargetSyncPayload,
  type HmuxStandalonePaneInspection,
  type RetargetHmuxStandalonePaneReceipt,
  type RetargetHmuxStandalonePaneRequest,
  type StandaloneHmuxPaneConsumer,
  type StandaloneHmuxPaneSetInspection,
  type StandaloneHmuxPaneSetReceipt,
  type StandaloneHmuxRetargetSyncPayload,
} from "@/lib/hmux/standalone/standaloneHmuxPaneSetProjection";
import { standaloneHmuxRetargetRetry } from "@/lib/hmux/standalone/standaloneHmuxRetargetRetry";

const LIVE_PROJECTION_ATTEMPTS = 3;

export const HMUX_STANDALONE_RETARGETED_EVENT =
  "hmux:standalone-pane-set-retargeted:v1";

export { projectStandaloneHmuxRetargetLayouts } from "@/lib/hmux/standalone/standaloneHmuxPaneSetProjection";
import { isRetiredLegacyPaneBinding } from "@/lib/hmux/standalone/standaloneHmuxPaneSetProjection";
export type { HmuxStandalonePaneInspection, RetargetHmuxStandalonePaneReceipt, RetargetHmuxStandalonePaneRequest, StandaloneHmuxPaneSetInspection, StandaloneHmuxPaneSetReceipt } from "@/lib/hmux/standalone/standaloneHmuxPaneSetProjection";

function snapshotLayouts(): Record<string, unknown> {
  const layouts = { ...useStore.getState().layouts };
  for (const [desktopId, api] of mountedDockviewEntries()) {
    try {
      layouts[desktopId] = api.toJSON();
    } catch {
      throw new PaneCommandError(
        "pane_changed",
        `desktop ${desktopId} could not be snapshotted before Hmux handoff`,
      );
    }
  }
  return layouts;
}

function exactStandaloneSummary(
  summary: HmuxSessionSummary | null | undefined,
): summary is HmuxSessionSummary {
  return summary?.sessionClass === "standalone";
}

async function sourceIdentityForTarget(
  params: Record<string, unknown>,
): Promise<{
  binding: HmuxStandalonePaneBindingV1;
  summary?: HmuxSessionSummary;
}> {
  const receiptSource = sourceStandaloneBindingFromHandoff(params);
  if (receiptSource) return { binding: receiptSource };

  const binding = standaloneTerminalBinding(params);
  if (
    binding?.runtime === "hmux_standalone_v1" &&
    binding.source === "local"
  ) {
    const candidate = await inspectHmuxSessionExact({
      sessionId: binding.sessionId,
      workspaceId: binding.workspaceId,
    }).catch(() => undefined);
    const summary = exactStandaloneSummary(candidate) ? candidate : undefined;
    return { binding, ...(summary ? { summary } : {}) };
  }
  if (binding?.runtime === "hmux_session_v1") {
    const candidate = await inspectHmuxSessionExact({
      sessionId: binding.sessionId,
      workspaceId: binding.workspaceId,
    });
    const summary = exactStandaloneSummary(candidate) ? candidate : undefined;
    if (summary) {
      return {
        binding: hmuxStandaloneBinding(summary.sessionId, summary.workspaceId),
        summary,
      };
    }
  }

  const outerSessionId =
    typeof params.sessionId === "string" ? params.sessionId : "";
  const attached = outerSessionId
    ? await querySessionHmux(outerSessionId)
    : null;
  if (exactStandaloneSummary(attached)) {
    return {
      binding: hmuxStandaloneBinding(attached.sessionId, attached.workspaceId),
      summary: attached,
    };
  }
  throw new PaneCommandError(
    "invalid_request",
    "terminal pane is not bound or attached to a standalone Hmux session",
  );
}

async function enumerateConsumers(
  layouts: Readonly<Record<string, unknown>>,
  source: HmuxStandalonePaneBindingV1,
): Promise<StandaloneHmuxPaneConsumer[]> {
  const candidates = Object.entries(layouts).flatMap(([desktopId, layout]) =>
    panelsFromLayout(layout)
      .filter((panel) => panel.component === "terminal")
      .map((panel) => ({ desktopId, panel })),
  );
  const attachedByOuterSession = new Map<
    string,
    Promise<HmuxSessionSummary | null>
  >();
  const attachedSummary = (sessionId: string) => {
    let pending = attachedByOuterSession.get(sessionId);
    if (!pending) {
      pending = querySessionHmux(sessionId).catch(() => null);
      attachedByOuterSession.set(sessionId, pending);
    }
    return pending;
  };

  const consumers = await Promise.all(
    candidates.map(async ({ desktopId, panel }) => {
      const params = panel.params;
      const cwd = typeof params.cwd === "string" ? { cwd: params.cwd } : {};
      const binding = standaloneTerminalBinding(params);
      const handoffSource = sourceStandaloneBindingFromHandoff(params);
      if (
        binding?.runtime === "hmux_standalone_v1" &&
        sameStandaloneHmuxIdentity(binding, source)
      ) {
        return {
          desktopId,
          panelId: panel.id,
          sourceTransportSessionId: binding.sessionId,
          state: "source" as const,
          ...cwd,
        };
      }
      if (
        binding?.runtime === "hmux_standalone_v1" &&
        handoffSource &&
        sameStandaloneHmuxIdentity(handoffSource, source)
      ) {
        return {
          desktopId,
          panelId: panel.id,
          sourceTransportSessionId:
            sourceTransportSessionFromHandoff(params) ?? source.sessionId,
          state: "target" as const,
          ...cwd,
        };
      }
      if (
        binding?.runtime === "hmux_session_v1" &&
        sameStandaloneHmuxIdentity(binding, source)
      ) {
        return {
          desktopId,
          panelId: panel.id,
          sourceTransportSessionId: binding.sessionId,
          state: "observer" as const,
          ...cwd,
        };
      }
      if (
        !isRetiredLegacyPaneBinding(params.binding) &&
        params.binding !== undefined
      ) {
        return undefined;
      }
      const outerSessionId =
        typeof params.sessionId === "string" ? params.sessionId : "";
      if (!outerSessionId) return undefined;
      const attached = await attachedSummary(outerSessionId);
      if (
        !exactStandaloneSummary(attached) ||
        attached.sessionId !== source.sessionId ||
        attached.workspaceId !== source.workspaceId
      ) {
        return undefined;
      }
      return {
        desktopId,
        panelId: panel.id,
        sourceTransportSessionId: outerSessionId,
        state: "legacy_attached" as const,
        ...cwd,
      };
    }),
  );
  return sortedStandaloneHmuxConsumers(
    consumers.filter(
      (consumer): consumer is StandaloneHmuxPaneConsumer => !!consumer,
    ),
  );
}

/**
 * Resolve the target's exact runtime identity, then pre-enumerate every
 * persisted pane consuming that identity. Legacy PTY wrappers are accepted
 * only when their daemon reports the exact attached standalone session.
 */
export async function inspectStandaloneHmuxPaneSet(
  requestedPanelId: string,
): Promise<StandaloneHmuxPaneSetInspection> {
  const panelId = requestedPanelId.trim();
  const resolved = await resolvePaneById(panelId);
  const panel = resolved.api.getPanel(resolved.panelId);
  if (!panel) {
    throw new PaneCommandError(
      "pane_not_found",
      `terminal pane ${panelId} detached during Hmux inspection`,
    );
  }
  if (panel.api.component !== "terminal") {
    throw new PaneCommandError("invalid_request", "targetPanelId must identify terminal content");
  }
  const params = dockPanelParameters(panel);
  const identity = await sourceIdentityForTarget(params);
  const layouts = snapshotLayouts();
  const consumers = await enumerateConsumers(layouts, identity.binding);
  const primary = consumers.find(
    (consumer) =>
      consumer.desktopId === resolved.desktopId &&
      consumer.panelId === resolved.panelId,
  );
  if (!primary) {
    throw new PaneCommandError(
      "pane_changed",
      `terminal pane ${panelId} changed during Hmux consumer enumeration`,
    );
  }
  return {
    source: {
      desktopId: primary.desktopId,
      panelId: primary.panelId,
      sessionId: identity.binding.sessionId,
      workspaceId: identity.binding.workspaceId,
      ...(primary.cwd ? { cwd: primary.cwd } : {}),
    },
    ...(identity.summary ? { sourceSummary: identity.summary } : {}),
    consumers,
  };
}

export async function inspectHmuxStandaloneTerminalPanel(
  requestedPanelId: string,
): Promise<HmuxStandalonePaneInspection> {
  return (await inspectStandaloneHmuxPaneSet(requestedPanelId)).source;
}

async function applyLiveProjection(
  consumers: readonly StandaloneHmuxPaneConsumer[],
  source: HmuxStandalonePaneBindingV1,
  payload?: StandaloneHmuxRetargetSyncPayload,
  maximumAttempts = LIVE_PROJECTION_ATTEMPTS,
): Promise<string[]> {
  const mountedDesktopIds = new Set(
    mountedDockviewEntries().map(([desktopId]) => desktopId),
  );
  let pending = consumers
    .filter((consumer) => mountedDesktopIds.has(consumer.desktopId))
    .map((consumer) => `${consumer.desktopId}\0${consumer.panelId}`);
  for (
    let attempt = 0;
    attempt < maximumAttempts && pending.length > 0;
    attempt += 1
  ) {
    const failed = new Set<string>();
    for (const [desktopId, api] of mountedDockviewEntries()) {
      for (const key of pending) {
        const [consumerDesktopId, panelId] = key.split("\0");
        if (consumerDesktopId !== desktopId) continue;
        const consumer = consumers.find(
          (candidate) =>
            candidate.desktopId === desktopId && candidate.panelId === panelId,
        );
        const panel = consumer ? api.getPanel(panelId) : undefined;
        if (!consumer || !panel || panel.api.component !== "terminal") {
          failed.add(key);
          continue;
        }
        const current = dockPanelParameters(panel);
        const projected = projectStandaloneHmuxConsumerParams(
          current,
          consumer,
          source,
          payload,
        );
        if (projected.state === "conflict") {
          failed.add(key);
          continue;
        }
        if (projected.params === current) continue;
        try {
          if (projected.params !== dockPanelParameters(panel)) {
            panel.api.updateParameters(projected.params);
          }
        } catch {
          failed.add(key);
        }
      }
    }
    pending = [...failed];
    if (pending.length > 0) await Promise.resolve();
  }
  return pending.map((key) => key.split("\0")[1]);
}

function commitProjection(
  consumers: readonly StandaloneHmuxPaneConsumer[],
  source: HmuxStandalonePaneBindingV1,
  payload?: StandaloneHmuxRetargetSyncPayload,
) {
  const projected = projectStandaloneHmuxLayouts(
    snapshotLayouts(),
    consumers,
    source,
    payload,
  );
  if (projected.conflicts.length > 0) {
    throw new PaneCommandError(
      "pane_changed",
      `standalone Hmux pane set changed: ${projected.conflicts.join(", ")}`,
    );
  }
  useStore.setState({ layouts: projected.layouts });
}

/**
 * Persist legacy/observer consumers as exact controller bindings before a
 * destructive backend operation. No operation begins while a mounted pane is
 * still on its outer transport.
 */
export async function prepareStandaloneHmuxPaneSet(
  inspection: StandaloneHmuxPaneSetInspection,
): Promise<StandaloneHmuxPaneSetInspection> {
  const refreshed = await inspectStandaloneHmuxPaneSet(
    inspection.source.panelId,
  );
  if (
    refreshed.source.sessionId !== inspection.source.sessionId ||
    refreshed.source.workspaceId !== inspection.source.workspaceId
  ) {
    throw new PaneCommandError(
      "pane_changed",
      `terminal pane ${inspection.source.panelId} changed before Hmux handoff`,
    );
  }
  const refreshedConsumers = new Set(
    refreshed.consumers.map(
      (consumer) => `${consumer.desktopId}\0${consumer.panelId}`,
    ),
  );
  const missingConsumers = inspection.consumers.filter(
    (consumer) =>
      !refreshedConsumers.has(`${consumer.desktopId}\0${consumer.panelId}`),
  );
  if (missingConsumers.length > 0) {
    throw new PaneCommandError(
      "pane_changed",
      `standalone Hmux consumers changed before handoff: ${missingConsumers
        .map((consumer) => consumer.panelId)
        .join(", ")}`,
    );
  }
  const source = hmuxStandaloneBinding(
    refreshed.source.sessionId,
    refreshed.source.workspaceId,
  );
  commitProjection(refreshed.consumers, source);
  const pending = await applyLiveProjection(refreshed.consumers, source);
  if (pending.length > 0) {
    throw new PaneCommandError(
      "pane_changed",
      `standalone Hmux promotion is pending for ${pending.join(", ")}`,
    );
  }
  return refreshed;
}

async function synchronizeStandaloneHmuxRetarget(
  payload: StandaloneHmuxRetargetSyncPayload,
): Promise<string[]> {
  commitProjection(payload.consumers, payload.source, payload);
  const pending = await applyLiveProjection(
    payload.consumers,
    payload.source,
    payload,
    1,
  );
  return pending;
}

function convergeStandaloneHmuxRetarget(
  payload: StandaloneHmuxRetargetSyncPayload,
): Promise<boolean> {
  return standaloneHmuxRetargetRetry.run(
    payload.operationId,
    JSON.stringify(payload),
    async () => (await synchronizeStandaloneHmuxRetarget(payload)).length === 0,
  );
}

subscribeDockviewRegistration((desktopId) => {
  for (const payload of durableStandaloneHmuxRetargets(
    useStore.getState().layouts,
  )) {
    if (
      payload.consumers.some((consumer) => consumer.desktopId === desktopId)
    ) {
      void convergeStandaloneHmuxRetarget(payload);
    }
  }
});

export async function applyStandaloneHmuxRetargetSync(
  value: unknown,
): Promise<boolean> {
  if (!validStandaloneHmuxRetargetSyncPayload(value)) return false;
  return convergeStandaloneHmuxRetarget(value);
}

export async function retargetStandaloneHmuxPaneSet(
  inspection: StandaloneHmuxPaneSetInspection,
  operation: {
    kind: "recovery" | "upgrade";
    operationId: string;
    replacement: HmuxSessionSummary;
  },
): Promise<StandaloneHmuxPaneSetReceipt> {
  const replacement = operation.replacement;
  if (
    !nonEmptyString(operation.operationId) ||
    !isWritableHealthyStandaloneReplacement(replacement) ||
    replacement.workspaceId !== inspection.source.workspaceId ||
    replacement.sessionId === inspection.source.sessionId
  ) {
    throw new Error("standalone Hmux retarget receipt identity mismatch");
  }
  const source = hmuxStandaloneBinding(
    inspection.source.sessionId,
    inspection.source.workspaceId,
  );
  const consumersByPane = new Map(
    inspection.consumers.map((consumer) => [
      `${consumer.desktopId}\0${consumer.panelId}`,
      consumer,
    ]),
  );
  for (const consumer of await enumerateConsumers(snapshotLayouts(), source)) {
    const key = `${consumer.desktopId}\0${consumer.panelId}`;
    if (!consumersByPane.has(key)) consumersByPane.set(key, consumer);
  }
  const payload: StandaloneHmuxRetargetSyncPayload = {
    schemaVersion: 1,
    operation: operation.kind,
    operationId: operation.operationId,
    source,
    target: hmuxStandaloneBinding(
      replacement.sessionId,
      replacement.workspaceId,
    ),
    consumers: sortedStandaloneHmuxConsumers([...consumersByPane.values()]),
  };
  commitProjection(payload.consumers, payload.source, payload);
  await emit(HMUX_STANDALONE_RETARGETED_EVENT, payload).catch(() => {});
  if (!(await convergeStandaloneHmuxRetarget(payload))) {
    throw new PaneCommandError(
      "pane_changed",
      `standalone Hmux retarget is pending for ${payload.consumers
        .map((consumer) => consumer.panelId)
        .join(", ")}`,
    );
  }
  const panes = payload.consumers.map((consumer) => ({
    desktopId: consumer.desktopId,
    panelId: consumer.panelId,
    sessionId: payload.target.sessionId,
    workspaceId: payload.target.workspaceId,
    binding: payload.target,
  }));
  const primary = panes.find(
    (pane) =>
      pane.desktopId === inspection.source.desktopId &&
      pane.panelId === inspection.source.panelId,
  );
  if (!primary) {
    throw new PaneCommandError(
      "pane_changed",
      "primary standalone Hmux pane disappeared from its durable pane set",
    );
  }
  return { primary, panes, pendingPanelIds: [], sync: payload };
}

/**
 * Explicit single-pane attach remains a narrow primitive. Recovery and
 * upgrade must use the pane-set transaction above.
 */
export async function retargetHmuxStandaloneTerminalPanel(
  request: RetargetHmuxStandalonePaneRequest,
  claim?: () => Promise<boolean>,
): Promise<RetargetHmuxStandalonePaneReceipt> {
  const panelId = request.panelId.trim();
  const sessionId = request.sessionId.trim();
  const workspaceId = request.workspaceId.trim();
  if (!panelId || !sessionId || !workspaceId) {
    throw new PaneCommandError(
      "invalid_request",
      "targetPanelId, sessionId and workspaceId are required",
    );
  }
  const resolved = await resolvePaneById(panelId);
  if (claim && !(await claim())) {
    throw new PaneCommandError(
      "request_expired",
      "pane request expired before mutation",
    );
  }
  const panel = resolved.api.getPanel(resolved.panelId);
  if (!panel) {
    throw new PaneCommandError(
      "pane_not_found",
      `terminal pane ${panelId} detached before mutation`,
    );
  }
  if (panel.api.component !== "terminal") {
    throw new PaneCommandError("invalid_request", "targetPanelId must identify terminal content");
  }
  const params = dockPanelParameters(panel);
  const previous = standaloneTerminalBinding(params);
  const commitPane = (targetPanel: IDockviewPanel) => {
    const next = projectStandaloneHmuxAttachParams(
      dockPanelParameters(targetPanel),
      { sessionId, workspaceId },
      request.cwd,
    );
    commitExplicitDockviewMutation({
      desktopId: resolved.desktopId,
      api: resolved.api,
      mutate: () => {
        targetPanel.api.updateParameters(next);
        targetPanel.api.setActive();
      },
      targetChangedError: () =>
        new PaneCommandError(
          "pane_changed",
          `terminal pane ${panelId} changed before Hmux mutation commit`,
        ),
    });
    return {
      desktopId: resolved.desktopId,
      panelId,
      sessionId,
      workspaceId,
      binding: hmuxStandaloneBinding(sessionId, workspaceId),
      cwd: request.cwd,
    };
  };
  if (
    (request.expectedSessionId || request.expectedWorkspaceId) &&
    (previous?.runtime !== "hmux_standalone_v1" ||
      (request.expectedSessionId &&
        previous.sessionId !== request.expectedSessionId) ||
      (request.expectedWorkspaceId &&
        previous.workspaceId !== request.expectedWorkspaceId))
  ) {
    throw new PaneCommandError(
      "pane_changed",
      `terminal pane ${panelId} changed before Hmux handoff`,
    );
  }
  const mutationPanel = resolved.api.getPanel(resolved.panelId);
  if (!mutationPanel) {
    throw new PaneCommandError(
      "pane_not_found",
      `terminal pane ${panelId} detached before Hmux mutation`,
    );
  }
  return commitPane(mutationPanel);
}
