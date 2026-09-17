import { describe, expect, it } from "vitest";
import { isHmuxTestOnlyPath } from "./hmux-test-only-path.mjs";

describe("Hmux test-only paths", () => {
  it("recognizes private Rust test modules and their submodules", () => {
    for (const path of [
      "hmux/crates/hmux-client/src/tests.rs",
      "hmux/crates/hmux-client/src/recovery_journal/tests.rs",
      "hmux/crates/hmux-client/src/recovery_journal/tests/overflow.rs",
    ]) {
      expect(isHmuxTestOnlyPath(path), path).toBe(true);
    }
  });

  it("does not widen the exception to production or integration tests", () => {
    for (const path of [
      "hmux/crates/hmux-client/src/recovery_journal.rs",
      "hmux/crates/hmux-client/src/contest.rs",
      "hmux/crates/hmux-client/tests/recovery_journal.rs",
      "src/recovery_journal/tests.rs",
      "bad\0path",
    ]) {
      expect(isHmuxTestOnlyPath(path), path).toBe(false);
    }
  });
});
