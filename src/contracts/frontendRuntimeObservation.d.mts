export type FrontendWorktreeOverlay = "clean" | "present" | "unknown";

export interface FrontendRuntimeObservation {
  schemaVersion: 1;
  buildId: string;
  sourceRevision: string | null;
  worktreeOverlay: FrontendWorktreeOverlay;
  backendRuntimeFingerprint: string | null;
}

export const FRONTEND_RUNTIME_OBSERVATION_SCHEMA_VERSION: 1;

export function isBackendRuntimeFingerprint(value: unknown): value is string;

export function normalizeFrontendRuntimeObservation(
  value: unknown,
): FrontendRuntimeObservation | null;

export function createFrontendRuntimeObservation(
  value: Omit<FrontendRuntimeObservation, "schemaVersion">,
): FrontendRuntimeObservation;

export function frontendRuntimeObservationMatchesTarget(
  value: unknown,
  targetHead: unknown,
): boolean;
