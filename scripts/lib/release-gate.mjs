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

export function exactSuccessfulCiRuns(baseInput, runs) {
  const base = normalizeFullCommitSha(baseInput, "release base");
  if (!Array.isArray(runs)) {
    throw new Error("CI run response must be an array");
  }
  return runs.filter(
    (run) =>
      typeof run?.headSha === "string" &&
      run.headSha.toLowerCase() === base &&
      run.status === "completed" &&
      run.conclusion === "success",
  );
}

export function findExactSuccessfulCiRun(baseInput, runs) {
  return exactSuccessfulCiRuns(baseInput, runs)[0] ?? null;
}

// A public-repository.yml run also concludes success when its plan skipped
// every code suite, as for a documentation-only push. Release evidence needs
// the required result and the code suites to have actually run and passed.
export const RELEASE_CI_REQUIRED_JOB = "Public repository checks";
// The frontend and script suites run as matrix jobs whose names carry a
// shard or test-file suffix, such as "Frontend checks (shard 1)".
export const RELEASE_CI_EVIDENCE_JOB_PREFIXES = Object.freeze([
  "Frontend checks",
  "Script checks",
]);

function conclusionGaps(job) {
  return job.conclusion === "success" ? [] : [`${job.name} ${job.conclusion || "unfinished"}`];
}

/** Why a run's latest-attempt job listing is not release evidence; [] if it is. */
export function ciEvidenceGaps(listing) {
  const jobs = listing?.jobs;
  if (!Array.isArray(jobs) || jobs.length !== listing.total_count) {
    return ["job listing incomplete"];
  }
  const named = jobs.filter((job) => typeof job?.name === "string");
  const required = named.filter((job) => job.name === RELEASE_CI_REQUIRED_JOB);
  const gaps =
    required.length === 1
      ? conclusionGaps(required[0])
      : [`${RELEASE_CI_REQUIRED_JOB} ${required.length === 0 ? "missing" : "ambiguous"}`];
  for (const prefix of RELEASE_CI_EVIDENCE_JOB_PREFIXES) {
    // Every job of the suite must have run and succeeded; none may be skipped.
    const suite = named.filter((job) => job.name.startsWith(prefix));
    gaps.push(...(suite.length === 0 ? [`${prefix} missing`] : suite.flatMap(conclusionGaps)));
  }
  return gaps;
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
