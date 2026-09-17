import type { HmuxSessionSummary } from "@/lib/ipc";
import { asRecord as record } from "@/lib/payloadGuards";
import { paneContentComponent } from "@/lib/workspace/layout/persistedPaneLayout";
import {
  hmuxStandaloneBinding,
  hmuxStandalonePaneParams,
  normalizeTerminalPaneBindingV1,
  type HmuxStandalonePaneBindingV1,
  type TerminalPaneBindingV1,
} from "@/lib/terminal/terminalBinding";

const HANDOFF_PARAM = "hmuxStandaloneHandoff";

export interface HmuxStandalonePaneInspection {
  desktopId: string;
  panelId: string;
  sessionId: string;
  workspaceId: string;
  cwd?: string;
}

export interface RetargetHmuxStandalonePaneRequest {
  panelId: string;
  sessionId: string;
  workspaceId: string;
  expectedSessionId?: string;
  expectedWorkspaceId?: string;
  cwd?: string;
}

export interface RetargetHmuxStandalonePaneReceipt {
  desktopId: string;
  panelId: string;
  sessionId: string;
  workspaceId: string;
  binding: TerminalPaneBindingV1;
  cwd?: string;
}

type StandaloneHmuxPaneConsumerState =
  | "legacy_attached"
  | "observer"
  | "source"
  | "target";

export interface StandaloneHmuxPaneConsumer {
  desktopId: string;
  panelId: string;
  sourceTransportSessionId: string;
  state: StandaloneHmuxPaneConsumerState;
  cwd?: string;
}

export interface StandaloneHmuxPaneSetInspection {
  source: HmuxStandalonePaneInspection;
  sourceSummary?: HmuxSessionSummary;
  consumers: readonly StandaloneHmuxPaneConsumer[];
}

export interface StandaloneHmuxRetargetSyncPayload {
  schemaVersion: 1;
  operation: "recovery" | "upgrade";
  operationId: string;
  source: HmuxStandalonePaneBindingV1;
  target: HmuxStandalonePaneBindingV1;
  consumers: readonly StandaloneHmuxPaneConsumer[];
}

interface StandaloneHmuxHandoffV1 {
  schemaVersion: 1;
  operation: "recovery" | "upgrade";
  operationId: string;
  sourceSessionId: string;
  sourceWorkspaceId: string;
  sourceTransportSessionId: string;
  targetSessionId: string;
  targetWorkspaceId: string;
}

export interface StandaloneHmuxPaneSetReceipt {
  primary: RetargetHmuxStandalonePaneReceipt;
  panes: readonly RetargetHmuxStandalonePaneReceipt[];
  pendingPanelIds: readonly string[];
  sync: StandaloneHmuxRetargetSyncPayload;
}

export type StandaloneHmuxConsumerProjectionState =
  | StandaloneHmuxPaneConsumerState
  | "missing"
  | "conflict";

export function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function sameStandaloneHmuxIdentity(
  binding: { sessionId: string; workspaceId: string } | undefined,
  identity: { sessionId: string; workspaceId: string },
): boolean {
  return (
    binding?.sessionId === identity.sessionId &&
    binding.workspaceId === identity.workspaceId
  );
}

export function standaloneTerminalBinding(
  params: Record<string, unknown>,
): TerminalPaneBindingV1 | undefined {
  const binding = normalizeTerminalPaneBindingV1(params.binding);
  return binding?.source === "local" && binding.sessionId === params.sessionId
    ? binding
    : undefined;
}

/** Project a standalone attach without carrying a cwd across session
 * identities. An omitted cwd remains valid only for the exact same target. */
export function projectStandaloneHmuxAttachParams(
  current: Record<string, unknown>,
  target: { sessionId: string; workspaceId: string },
  cwd?: string,
): Record<string, unknown> {
  const previous = standaloneTerminalBinding(current);
  const next = hmuxStandalonePaneParams(
    current,
    target.sessionId,
    target.workspaceId,
    cwd,
  );
  if (cwd === undefined && !sameStandaloneHmuxIdentity(previous, target)) {
    delete next.cwd;
  }
  return next;
}

function handoffFromParams(
  params: Record<string, unknown>,
): StandaloneHmuxHandoffV1 | undefined {
  const value = record(params[HANDOFF_PARAM]);
  if (
    value?.schemaVersion !== 1 ||
    (value.operation !== "recovery" && value.operation !== "upgrade") ||
    !nonEmptyString(value.operationId) ||
    !nonEmptyString(value.sourceSessionId) ||
    !nonEmptyString(value.sourceWorkspaceId) ||
    !nonEmptyString(value.sourceTransportSessionId) ||
    !nonEmptyString(value.targetSessionId) ||
    !nonEmptyString(value.targetWorkspaceId) ||
    value.sourceSessionId === value.targetSessionId ||
    value.sourceWorkspaceId !== value.targetWorkspaceId
  ) {
    return undefined;
  }
  return value as unknown as StandaloneHmuxHandoffV1;
}

function handoffForPayload(
  payload: StandaloneHmuxRetargetSyncPayload,
  consumer: StandaloneHmuxPaneConsumer,
): StandaloneHmuxHandoffV1 {
  return {
    schemaVersion: 1,
    operation: payload.operation,
    operationId: payload.operationId,
    sourceSessionId: payload.source.sessionId,
    sourceWorkspaceId: payload.source.workspaceId,
    sourceTransportSessionId: consumer.sourceTransportSessionId,
    targetSessionId: payload.target.sessionId,
    targetWorkspaceId: payload.target.workspaceId,
  };
}

function handoffMatchesPayload(
  handoff: StandaloneHmuxHandoffV1 | undefined,
  payload: StandaloneHmuxRetargetSyncPayload,
  consumer: StandaloneHmuxPaneConsumer,
): boolean {
  return (
    handoff?.operation === payload.operation &&
    handoff.operationId === payload.operationId &&
    handoff.sourceSessionId === payload.source.sessionId &&
    handoff.sourceWorkspaceId === payload.source.workspaceId &&
    handoff.sourceTransportSessionId === consumer.sourceTransportSessionId &&
    handoff.targetSessionId === payload.target.sessionId &&
    handoff.targetWorkspaceId === payload.target.workspaceId
  );
}

export function sourceStandaloneBindingFromHandoff(
  params: Record<string, unknown>,
): HmuxStandalonePaneBindingV1 | undefined {
  const handoff = handoffFromParams(params);
  const binding = standaloneTerminalBinding(params);
  if (
    !handoff ||
    binding?.runtime !== "hmux_standalone_v1" ||
    binding.sessionId !== handoff.targetSessionId ||
    binding.workspaceId !== handoff.targetWorkspaceId
  ) {
    return undefined;
  }
  return hmuxStandaloneBinding(
    handoff.sourceSessionId,
    handoff.sourceWorkspaceId,
  );
}

export function sourceTransportSessionFromHandoff(
  params: Record<string, unknown>,
): string | undefined {
  return handoffFromParams(params)?.sourceTransportSessionId;
}

export function sortedStandaloneHmuxConsumers(
  consumers: readonly StandaloneHmuxPaneConsumer[],
): StandaloneHmuxPaneConsumer[] {
  return [...consumers].sort((left, right) =>
    `${left.desktopId}\0${left.panelId}`.localeCompare(
      `${right.desktopId}\0${right.panelId}`,
    ),
  );
}

export function projectStandaloneHmuxConsumerParams(
  params: Record<string, unknown>,
  consumer: StandaloneHmuxPaneConsumer,
  source: HmuxStandalonePaneBindingV1,
  payload?: StandaloneHmuxRetargetSyncPayload,
): {
  state: StandaloneHmuxConsumerProjectionState;
  params: Record<string, unknown>;
} {
  const binding = standaloneTerminalBinding(params);
  let state: StandaloneHmuxConsumerProjectionState = "conflict";
  if (
    binding?.runtime === "hmux_standalone_v1" &&
    sameStandaloneHmuxIdentity(binding, source)
  ) {
    state = "source";
  } else if (
    payload &&
    binding?.runtime === "hmux_standalone_v1" &&
    sameStandaloneHmuxIdentity(binding, payload.target)
  ) {
    state = "target";
  } else if (
    !payload &&
    binding?.runtime === "hmux_standalone_v1" &&
    sameStandaloneHmuxIdentity(
      sourceStandaloneBindingFromHandoff(params),
      source,
    )
  ) {
    state = "target";
  } else if (
    binding?.runtime === "hmux_session_v1" &&
    sameStandaloneHmuxIdentity(binding, source) &&
    consumer.sourceTransportSessionId === source.sessionId
  ) {
    state = "observer";
  } else if (
    (isRetiredLegacyPaneBinding(params.binding) ||
      (binding === undefined && params.binding === undefined)) &&
    params.sessionId === consumer.sourceTransportSessionId
  ) {
    state = "legacy_attached";
  }

  if (state === "conflict") return { state, params };
  if (
    state === "target" &&
    payload &&
    handoffMatchesPayload(handoffFromParams(params), payload, consumer)
  ) {
    return { state, params };
  }
  if (state === "source" && !payload) return { state, params };
  if (state === "target" && !payload) return { state, params };

  const target = payload?.target ?? source;
  const next = projectStandaloneHmuxAttachParams(params, target);
  if (payload) next[HANDOFF_PARAM] = handoffForPayload(payload, consumer);
  else delete next[HANDOFF_PARAM];
  return { state, params: next };
}

function cloneLayout(layout: unknown): Record<string, unknown> | undefined {
  try {
    return JSON.parse(JSON.stringify(layout)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function projectStandaloneHmuxLayouts(
  layouts: Readonly<Record<string, unknown>>,
  consumers: readonly StandaloneHmuxPaneConsumer[],
  source: HmuxStandalonePaneBindingV1,
  payload?: StandaloneHmuxRetargetSyncPayload,
): {
  layouts: Record<string, unknown>;
  states: Readonly<Record<string, StandaloneHmuxConsumerProjectionState>>;
  conflicts: readonly string[];
} {
  const nextLayouts = { ...layouts };
  const states: Record<string, StandaloneHmuxConsumerProjectionState> = {};
  const conflicts: string[] = [];
  const byDesktop = new Map<string, StandaloneHmuxPaneConsumer[]>();
  for (const consumer of consumers) {
    const current = byDesktop.get(consumer.desktopId) ?? [];
    current.push(consumer);
    byDesktop.set(consumer.desktopId, current);
  }

  for (const [desktopId, desktopConsumers] of byDesktop) {
    const cloned = cloneLayout(layouts[desktopId]);
    if (!cloned) {
      for (const consumer of desktopConsumers) {
        const key = `${desktopId}:${consumer.panelId}`;
        states[key] = "missing";
        conflicts.push(key);
      }
      continue;
    }
    for (const consumer of desktopConsumers) {
      const key = `${desktopId}:${consumer.panelId}`;
      const panel = record(record(cloned.panels)?.[consumer.panelId]);
      const params = record(panel?.params);
      if (!params) {
        states[key] = "missing";
        conflicts.push(key);
        continue;
      }
      if (paneContentComponent(panel) !== "terminal") {
        states[key] = "conflict";
        conflicts.push(key);
        continue;
      }
      const projected = projectStandaloneHmuxConsumerParams(
        params,
        consumer,
        source,
        payload,
      );
      states[key] = projected.state;
      if (projected.state === "conflict") {
        conflicts.push(key);
        continue;
      }
      if (panel) panel.params = projected.params;
    }
    nextLayouts[desktopId] = cloned;
  }
  return { layouts: nextLayouts, states, conflicts };
}

/** Raw persisted params carrying the retired local-legacy runtime. The typed
 * union no longer contains it, but pre-migration layouts still do — pane-set
 * recovery/retarget classifies them `legacy_attached` so the CLI retarget can
 * still revive their standalone Hosts under a proper binding. */
export function isRetiredLegacyPaneBinding(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { runtime?: unknown }).runtime === "legacy_session_v1"
  );
}

export function projectStandaloneHmuxRetargetLayouts(
  layouts: Readonly<Record<string, unknown>>,
  payload: StandaloneHmuxRetargetSyncPayload,
) {
  return projectStandaloneHmuxLayouts(
    layouts,
    payload.consumers,
    payload.source,
    payload,
  );
}

export function durableStandaloneHmuxRetargets(
  layouts: Readonly<Record<string, unknown>>,
): StandaloneHmuxRetargetSyncPayload[] {
  const operations = new Map<
    string,
    {
      payload: StandaloneHmuxRetargetSyncPayload;
      identity: string;
      conflict: boolean;
    }
  >();
  for (const [desktopId, layout] of Object.entries(layouts)) {
    const panels = record(record(layout)?.panels);
    if (!panels) continue;
    for (const [panelId, panelValue] of Object.entries(panels)) {
      if (paneContentComponent(panelValue) !== "terminal") continue;
      const params = record(record(panelValue)?.params);
      const handoff = params ? handoffFromParams(params) : undefined;
      const binding = params ? standaloneTerminalBinding(params) : undefined;
      if (
        !handoff ||
        binding?.runtime !== "hmux_standalone_v1" ||
        binding.sessionId !== handoff.targetSessionId ||
        binding.workspaceId !== handoff.targetWorkspaceId
      ) {
        continue;
      }
      const source = hmuxStandaloneBinding(
        handoff.sourceSessionId,
        handoff.sourceWorkspaceId,
      );
      const target = hmuxStandaloneBinding(
        handoff.targetSessionId,
        handoff.targetWorkspaceId,
      );
      const identity = JSON.stringify({
        operation: handoff.operation,
        source,
        target,
      });
      const cwd = params?.cwd;
      const consumer: StandaloneHmuxPaneConsumer = {
        desktopId,
        panelId,
        sourceTransportSessionId: handoff.sourceTransportSessionId,
        state: "target",
        ...(nonEmptyString(cwd) ? { cwd } : {}),
      };
      const current = operations.get(handoff.operationId);
      if (!current) {
        operations.set(handoff.operationId, {
          identity,
          conflict: false,
          payload: {
            schemaVersion: 1,
            operation: handoff.operation,
            operationId: handoff.operationId,
            source,
            target,
            consumers: [consumer],
          },
        });
        continue;
      }
      if (current.identity !== identity) {
        current.conflict = true;
        continue;
      }
      current.payload = {
        ...current.payload,
        consumers: [...current.payload.consumers, consumer],
      };
    }
  }
  return [...operations.values()]
    .filter(({ conflict }) => !conflict)
    .map(({ payload }) => ({
      ...payload,
      consumers: sortedStandaloneHmuxConsumers(payload.consumers),
    }))
    .sort((left, right) => left.operationId.localeCompare(right.operationId));
}

export function validStandaloneHmuxRetargetSyncPayload(
  value: unknown,
): value is StandaloneHmuxRetargetSyncPayload {
  const payload = record(value);
  const source = normalizeTerminalPaneBindingV1(payload?.source);
  const target = normalizeTerminalPaneBindingV1(payload?.target);
  if (
    payload?.schemaVersion !== 1 ||
    (payload.operation !== "recovery" && payload.operation !== "upgrade") ||
    !nonEmptyString(payload.operationId) ||
    source?.runtime !== "hmux_standalone_v1" ||
    target?.runtime !== "hmux_standalone_v1" ||
    source.workspaceId !== target.workspaceId ||
    source.sessionId === target.sessionId ||
    !Array.isArray(payload.consumers) ||
    payload.consumers.length === 0
  ) {
    return false;
  }
  const keys = new Set<string>();
  for (const value of payload.consumers) {
    const consumer = record(value);
    if (
      !consumer ||
      !nonEmptyString(consumer.desktopId) ||
      !nonEmptyString(consumer.panelId) ||
      !nonEmptyString(consumer.sourceTransportSessionId) ||
      !["legacy_attached", "observer", "source", "target"].includes(
        String(consumer.state),
      )
    ) {
      return false;
    }
    const key = `${consumer.desktopId}\0${consumer.panelId}`;
    if (keys.has(key)) return false;
    keys.add(key);
  }
  return true;
}
