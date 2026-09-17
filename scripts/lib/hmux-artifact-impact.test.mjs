import { describe, expect, test } from "vitest";
import { requiresHmuxArtifact } from "./hmux-artifact-impact.mjs";

describe("Hmux Linux artifact impact", () => {
  test("includes every shared Rust producer consumed by the Hmux artifact", () => {
    for (const path of [
      "crates/hebbian-bounded-process/src/lib.rs",
      "crates/hebbian-process-sampler/src/lib.rs",
      "hmux/crates/hmux-runtime/src/main.rs",
    ]) {
      expect(requiresHmuxArtifact([path]), path).toBe(true);
    }
  });

  test("preserves the private Hmux test-only exclusion", () => {
    for (const path of [
      "hmux/crates/hmux-client/src/tests.rs",
      "hmux/crates/hmux-client/src/recovery/tests/overflow.rs",
    ]) {
      expect(requiresHmuxArtifact([path]), path).toBe(false);
    }
    expect(
      requiresHmuxArtifact([
        "hmux/crates/hmux-client/src/tests.rs",
        "hmux/crates/hmux-client/src/lib.rs",
      ]),
    ).toBe(true);
  });

  test("covers artifact pipeline authority without widening ordinary product paths", () => {
    for (const path of [
      ".github/workflows/ci.yml",
      ".github/workflows/hmux-linux-artifact-dispatcher.yml",
      "scripts/build-hmux-product-runtime.sh",
      "scripts/with-hmux-build-environment.sh",
      "scripts/ensure-ghostty-vt-proof.mjs",
      "scripts/ghostty-vt-materialization.test.mjs",
      "scripts/internal/ci-verification-workflow.test.mjs",
      "scripts/internal/hmux-artifact-dispatcher-workflow.test.mjs",
      "scripts/internal/hmux-linux-artifact-native.test.mjs",
      "scripts/internal/hmux-linux-artifacts.test.mjs",
      "scripts/internal/hmux-release-promotion.test.mjs",
      "scripts/internal/hmux-release-trust-policy.test.mjs",
      "scripts/hmux-linux-artifact-native.test.mjs",
      "scripts/hmux-release-trust-policy.test.mjs",
      "scripts/release-reporter.test.mjs",
      "scripts/hmux-ghostty-zig-ar.sh",
      "scripts/hmux-ghostty-zig-cc.sh",
      "scripts/lib/hmux-artifact-impact.mjs",
      "scripts/verify-hmux-product-runtime.sh",
      "src-tauri/resources/hmux-tuf/root.json",
    ]) {
      expect(requiresHmuxArtifact([path]), path).toBe(true);
    }
    for (const path of [
      "docs/operations/hmux.md",
      "mobile/src/App.tsx",
      "src/components/AgentPanel.tsx",
    ]) {
      expect(requiresHmuxArtifact([path]), path).toBe(false);
    }
  });

  test("fails closed when exact changed-path authority is unavailable", () => {
    expect(requiresHmuxArtifact([])).toBe(false);
    expect(requiresHmuxArtifact(null)).toBe(true);
    expect(requiresHmuxArtifact(["bad\0path"])).toBe(true);
  });
});
