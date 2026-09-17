export const FRONTEND_RUNTIME_OBSERVATION_SCHEMA_VERSION = 1;

const BUILD_ID_PATTERN = /^\d+\.\d+\.\d+\+[A-Za-z0-9._+-]+$/;
const SOURCE_REVISION_PATTERN = /^[0-9a-f]{12}$/;
const RUNTIME_FINGERPRINT_PATTERN = /^git-object-v1:[0-9a-f]{40,64}$/;
const WORKTREE_OVERLAYS = new Set(["clean", "present", "unknown"]);

export function isBackendRuntimeFingerprint(value) {
  return (
    typeof value === "string" && RUNTIME_FINGERPRINT_PATTERN.test(value)
  );
}

export function normalizeFrontendRuntimeObservation(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schemaVersion !== FRONTEND_RUNTIME_OBSERVATION_SCHEMA_VERSION ||
    typeof value.buildId !== "string" ||
    value.buildId.length > 128 ||
    !BUILD_ID_PATTERN.test(value.buildId) ||
    (value.sourceRevision !== null &&
      (typeof value.sourceRevision !== "string" ||
        !SOURCE_REVISION_PATTERN.test(value.sourceRevision))) ||
    !WORKTREE_OVERLAYS.has(value.worktreeOverlay) ||
    (value.sourceRevision === null) !== (value.worktreeOverlay === "unknown") ||
    (value.backendRuntimeFingerprint !== null &&
      !isBackendRuntimeFingerprint(value.backendRuntimeFingerprint))
  ) {
    return null;
  }

  return {
    schemaVersion: FRONTEND_RUNTIME_OBSERVATION_SCHEMA_VERSION,
    buildId: value.buildId,
    sourceRevision: value.sourceRevision,
    worktreeOverlay: value.worktreeOverlay,
    backendRuntimeFingerprint: value.backendRuntimeFingerprint,
  };
}

export function createFrontendRuntimeObservation(value) {
  const observation = normalizeFrontendRuntimeObservation({
    schemaVersion: FRONTEND_RUNTIME_OBSERVATION_SCHEMA_VERSION,
    ...value,
  });
  if (!observation) {
    throw new Error("invalid frontend runtime observation");
  }
  return observation;
}

export function frontendRuntimeObservationMatchesTarget(value, targetHead) {
  const observation = normalizeFrontendRuntimeObservation(value);
  return (
    observation !== null &&
    typeof targetHead === "string" &&
    /^[0-9a-f]{40,64}$/.test(targetHead) &&
    observation.sourceRevision === targetHead.slice(0, 12)
  );
}
