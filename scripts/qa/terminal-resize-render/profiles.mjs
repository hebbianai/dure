import { WINDOW_ROLES } from "../lib/hmux-window-focus-harness.mjs";
import {
  workspacePerformanceProviderDescriptor,
  workspacePerformanceProviderNames,
  workspacePerformanceProviders,
} from "../lib/workspace-performance-providers.mjs";

export const TERMINAL_RESIZE_RENDER_PROFILES = Object.freeze(
  Object.fromEntries(
    workspacePerformanceProviders.map(({ id, resizeBuffer }) => [
      id,
      Object.freeze({ provider: id, buffer: resizeBuffer }),
    ]),
  ),
);

export const configuredProviderNames = workspacePerformanceProviderNames;

export function selectedProviders(value = "all") {
  if (value === "all") return configuredProviderNames;
  if (workspacePerformanceProviderDescriptor(value)) return [value];
  throw new Error(
    `provider must be one of ${configuredProviderNames.join(", ")}, or all`,
  );
}

export function resizeRenderPhase(
  status,
  profile,
  minimumGeneration = 0,
  roles = WINDOW_ROLES,
  fitReferenceRole,
) {
  if (roles.length === 0) return undefined;
  const observations = roles.map(
    (role) => status.windows?.[role]?.bufferState?.resizeRender,
  );
  const frameIntegrity = roles.map(
    (role) => status.windows?.[role]?.resizeRenderIntegrity,
  );
  if (
    observations.some(
      (observation) =>
        !observation ||
        observation.provider !== profile.provider ||
        observation.buffer !== profile.buffer ||
        observation.generation <= minimumGeneration ||
        !observation.dimensionsMatch ||
        !observation.footerVisible,
    ) ||
    frameIntegrity.some(
      (integrity) =>
        !integrity ||
        integrity.validFrames < 1 ||
        integrity.violationFrames !== 0,
    )
  ) {
    return undefined;
  }
  if (
    fitReferenceRole &&
    (!roles.includes(fitReferenceRole) ||
      status.windows?.[fitReferenceRole]?.bufferState?.fitDimensionsMatch !==
        true)
  ) {
    return undefined;
  }
  const [first] = observations;
  if (
    observations.some(
      (observation) =>
        observation.generation !== first.generation ||
        observation.terminalColumns !== first.terminalColumns ||
        observation.terminalRows !== first.terminalRows,
    )
  ) {
    return undefined;
  }
  return {
    generation: first.generation,
    columns: first.terminalColumns,
    rows: first.terminalRows,
    buffers: Object.fromEntries(
      roles.map((role, index) => [role, observations[index].buffer]),
    ),
    snapshotCollapses: Object.fromEntries(
      roles.map((role) => [
        role,
        status.windows[role].renderMetrics?.snapshotCollapses ?? 0,
      ]),
    ),
    maxWriteLatencyMs: Math.max(
      ...roles.map(
        (role) => status.windows[role].renderMetrics?.maxWriteLatencyMs ?? 0,
      ),
    ),
    frameIntegrity: Object.fromEntries(
      roles.map((role, index) => [role, frameIntegrity[index]]),
    ),
  };
}

export function requireResizeRenderPhase(
  status,
  profile,
  minimumGeneration,
  description,
  roles = WINDOW_ROLES,
  fitReferenceRole,
) {
  const phase = resizeRenderPhase(
    status,
    profile,
    minimumGeneration,
    roles,
    fitReferenceRole,
  );
  if (!phase) {
    throw new Error(
      `${description}: terminal frame does not satisfy the ${profile.provider}/${profile.buffer} resize contract: ${JSON.stringify(status.windows)}`,
    );
  }
  return phase;
}
