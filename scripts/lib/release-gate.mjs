const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/i;
const RELEASE_VERSION = /^\d+\.\d+\.\d+$/;

// Standing user authority for the macOS Basic public-beta series, not later minors.
export const V02_EMERGENCY_AUTHORITY = "#6555646053066";

export function isV02ReleaseVersion(version) {
  return typeof version === "string" && /^0\.2\.\d+$/.test(version);
}

export function selectReleaseEvent({ version, beta }) {
  if (!isV02ReleaseVersion(version)) return "release";
  if (!beta) throw new Error("release_beta_required: 0.2.x releases require --beta");
  return "macos-basic-v0.2-beta";
}

export function normalizeFullCommitSha(value, label = "commit SHA") {
  if (typeof value !== "string" || !FULL_COMMIT_SHA.test(value)) {
    throw new Error(`${label} must be a full 40-character commit SHA`);
  }
  return value.toLowerCase();
}

export function normalizeReleaseBump(value) {
  if (value !== "patch" && value !== "minor") {
    throw new Error("release bump must be patch or minor");
  }
  return value;
}

export function normalizeReleaseVersion(value) {
  const normalized = String(value ?? "").trim();
  if (!RELEASE_VERSION.test(normalized)) {
    throw new Error("release version must be X.Y.Z");
  }
  return normalized;
}

export function assertPinnedCheckout(baseInput, headInput) {
  const base = normalizeFullCommitSha(baseInput, "release base");
  const head = normalizeFullCommitSha(headInput, "checked-out HEAD");
  if (head !== base) {
    throw new Error(`release_checkout_mismatch: expected ${base}, checked out ${head}`);
  }
  return base;
}

export function findExactSuccessfulCiRun(baseInput, runs) {
  const base = normalizeFullCommitSha(baseInput, "release base");
  if (!Array.isArray(runs)) {
    throw new Error("CI run response must be an array");
  }
  return (
    runs.find(
      (run) =>
        typeof run?.headSha === "string" &&
        run.headSha.toLowerCase() === base &&
        run.status === "completed" &&
        run.conclusion === "success",
    ) ?? null
  );
}

export function describeExactCiRuns(baseInput, runs) {
  const base = normalizeFullCommitSha(baseInput, "release base");
  if (!Array.isArray(runs)) return "invalid response";
  const exact = runs.filter(
    (run) => typeof run?.headSha === "string" && run.headSha.toLowerCase() === base,
  );
  if (exact.length === 0) return "missing";
  return exact
    .map((run) => `${run.status ?? "unknown"}/${run.conclusion ?? "none"}`)
    .join(", ");
}
