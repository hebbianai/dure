import { isHmuxTestOnlyPath } from "./hmux-test-only-path.mjs";

// Production inputs and verification authority for the distributable Hmux
// Linux artifact. Keep this as the only changed-path authority: CI evaluates
// it over its exact verifiedBase..verifiedHead range, including coordinator
// source commits hidden behind an empty landing marker.
const EXACT_INPUTS = new Set([
  ".cargo/config.toml",
  ".github/workflows/ci.yml",
  ".github/workflows/hmux-linux-artifact-dispatcher.yml",
  ".github/workflows/hmux-linux-artifacts.yml",
  ".github/workflows/hmux-release-promotion.yml",
  ".github/workflows/hmux-release-renewal.yml",
  ".github/workflows/hmux-release-trust.yml",
  "pnpm-lock.yaml",
  "scripts/build-hmux-product-runtime.sh",
  "scripts/with-hmux-build-environment.sh",
  "scripts/ci-tool-cache.sh",
  "scripts/ci-verification-receipt-cli.test.mjs",
  "scripts/ci-verification-receipt.mjs",
  "scripts/internal/ci-verification-workflow.test.mjs",
  "scripts/release-reporter.test.mjs",
  "scripts/ensure-ghostty-vt-proof.mjs",
  "scripts/ghostty-vt-materialization.test.mjs",
  "scripts/internal/hmux-artifact-dispatcher-workflow.test.mjs",
  "scripts/hmux-artifact-dispatcher.mjs",
  "scripts/hmux-artifact-dispatcher.test.mjs",
  "scripts/hmux-artifact-verification.test.mjs",
  "scripts/hmux-linux-artifact-native.test.mjs",
  "scripts/internal/hmux-linux-artifact-native.test.mjs",
  "scripts/internal/hmux-linux-artifacts.test.mjs",
  "scripts/hmux-ghostty-zig-ar.sh",
  "scripts/hmux-ghostty-zig-cc.sh",
  "scripts/hmux-release-artifact-selection.test.mjs",
  "scripts/hmux-release-product-proof.mjs",
  "scripts/hmux-release-product-proof.test.mjs",
  "scripts/internal/hmux-release-promotion.test.mjs",
  "scripts/hmux-release-trust-policy.test.mjs",
  "scripts/internal/hmux-release-trust-policy.test.mjs",
  "scripts/install-hmux.sh",
  "scripts/lib/ci-verification-receipt.mjs",
  "scripts/lib/ci-verification-receipt.test.mjs",
  "scripts/lib/hmux-artifact-dispatcher-core.mjs",
  "scripts/lib/hmux-artifact-dispatcher-core.test.mjs",
  "scripts/lib/hmux-artifact-impact.mjs",
  "scripts/lib/hmux-artifact-impact.test.mjs",
  "scripts/lib/hmux-release-activation-readiness.mjs",
  "scripts/lib/hmux-test-only-path.mjs",
  "scripts/lib/hmux-test-only-path.test.mjs",
  "scripts/lib/push-gate-scope.mjs",
  "scripts/lib/wait-ci-green.mjs",
  "scripts/manage-ci-cargo-target.sh",
  "scripts/package-hmux-prebuilt.sh",
  "scripts/prepare-ci-cargo-home.sh",
  "scripts/push-gate-scope.test.mjs",
  "scripts/verify-hmux-product-runtime.sh",
  "scripts/qa/hmux-linux-artifact-exact-cleanup.py",
  "scripts/qa/hmux-linux-artifact-lima.sh",
  "scripts/qa/hmux-linux-artifact-lima.yaml",
  "scripts/qa/hmux-linux-artifact-probe.py",
  "scripts/qa/select-hmux-release-artifact.sh",
  "scripts/wait-ci-green.test.mjs",
  "scripts/fixtures/hmux-release-trust-policy.json",
  "src-tauri/Cargo.lock",
  "src-tauri/Cargo.toml",
  "src-tauri/build.rs",
  "src-tauri/src/lib.rs",
  "src-tauri/tauri.conf.json",
]);

const INPUT_PREFIXES = [
  "crates/hebbian-bounded-process/",
  "crates/hebbian-process-sampler/",
  "scripts/qa/hmux-tuf-conformance",
  "src-tauri/resources/hmux-tuf/",
  "src-tauri/src/hmux/",
];

function pathRequiresHmuxArtifact(path) {
  if (path.startsWith("hmux/")) return !isHmuxTestOnlyPath(path);
  if (EXACT_INPUTS.has(path)) return true;
  return INPUT_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export function requiresHmuxArtifact(paths) {
  // Missing or malformed diff authority must not silently suppress a release
  // artifact. An exact empty range is valid and needs no artifact.
  if (!Array.isArray(paths)) return true;
  for (const path of paths) {
    if (
      typeof path !== "string" ||
      path.length === 0 ||
      path.includes("\0") ||
      pathRequiresHmuxArtifact(path)
    ) {
      return true;
    }
  }
  return false;
}
