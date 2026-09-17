import { describe, expect, test } from "vitest";
import { requiresHmuxBackgroundSmoke } from "./hmux-background-smoke-scope.mjs";

describe("Hmux background smoke scope", () => {
  test("skips unrelated desktop UI and mobile changes", () => {
    expect(
      requiresHmuxBackgroundSmoke([
        "src/components/SpacesRows.tsx",
        "src/components/SpacesRows.test.tsx",
      ]),
    ).toBe(false);
    expect(requiresHmuxBackgroundSmoke(["src/index.css"])).toBe(false);
    expect(requiresHmuxBackgroundSmoke(["hmux/AGENTS.md"])).toBe(false);
    expect(requiresHmuxBackgroundSmoke(["mobile/src/App.tsx"])).toBe(false);
    expect(
      requiresHmuxBackgroundSmoke(["mobile/src-tauri/src/lib.rs"]),
    ).toBe(false);
  });

  test("covers the terminal delivery runtime", () => {
    for (const path of [
      "src/components/terminal/TerminalViewChrome.tsx",
      "src/components/terminal/VisibilityRetainedStructuredTerminal.tsx",
      "src/components/terminal/structured/useStructuredTerminalOutboundIntents.ts",
      "src/lib/terminal/transport.ts",
      "src/lib/hmux/hmuxConnectionDiagnostics.ts",
      "src/lib/workspace/window/windows.ts",
      "src-tauri/src/hmux/observer_delivery.rs",
      "hmux/crates/hmux-runtime/src/main.rs",
    ]) {
      expect(requiresHmuxBackgroundSmoke([path]), path).toBe(true);
    }
  });

  test("ipc 배럴 분할 모듈: 전달 경로는 smoke, 무관 도메인은 제외", () => {
    // 배럴(ipc.ts)만 목록에 있으면 분할된 구현 파일 직접 수정이 조용히
    // 빠진다 — 2026-08-01 ipc 도메인 분할이 만든 공백의 회귀 테스트.
    for (const path of [
      "src/lib/ipc/hmux.ts",
      "src/lib/ipc/hmuxContracts.ts",
      "src/lib/ipc/core.ts",
      "src/lib/ipc/sessions.ts",
      "src/lib/ipc/spawn.ts",
    ]) {
      expect(requiresHmuxBackgroundSmoke([path]), path).toBe(true);
    }
    for (const path of ["src/lib/ipc/git.ts", "src/lib/ipc/designMode.ts"]) {
      expect(requiresHmuxBackgroundSmoke([path]), path).toBe(false);
    }
  });

  test("skips private Hmux test modules without skipping production siblings", () => {
    expect(
      requiresHmuxBackgroundSmoke([
        "hmux/crates/hmux-client/src/recovery_journal/tests.rs",
      ]),
    ).toBe(false);
    expect(
      requiresHmuxBackgroundSmoke([
        "hmux/crates/hmux-client/src/recovery_journal.rs",
      ]),
    ).toBe(true);
  });

  test("does not recursively run behavior smoke for QA harness changes", () => {
    expect(
      requiresHmuxBackgroundSmoke([
        "src/qa/hmuxWindowFocus.tsx",
        "scripts/qa/hmux-window-background-client.mjs",
      ]),
    ).toBe(false);
  });

  test("uses script tests as evidence for Node-based development tooling", () => {
    expect(
      requiresHmuxBackgroundSmoke([
        "scripts/internal/direct-main-push-contract.test.mjs",
        "scripts/dure-orchestration-status.test.mjs",
        "scripts/dure-orchestration-status.mjs",
        "scripts/lib/push-gate-scope.mjs",
      ]),
    ).toBe(false);
  });

  test("uses CLI contract tests instead of the Hmux app smoke for known Node CLI modules", () => {
    expect(
      requiresHmuxBackgroundSmoke([
        "cli/dure.mjs",
        "cli/lib/orchestration-command.mjs",
      ]),
    ).toBe(false);
    expect(requiresHmuxBackgroundSmoke(["cli/hebbian-agent-hook.py"])).toBe(
      true,
    );
  });

  test("keeps shared and malformed inputs fail-closed", () => {
    expect(
      requiresHmuxBackgroundSmoke(["scripts/stage-hmux-runtime.sh"]),
    ).toBe(true);
    expect(requiresHmuxBackgroundSmoke(["package.json"])).toBe(true);
    expect(requiresHmuxBackgroundSmoke(["unknown"])).toBe(true);
    expect(requiresHmuxBackgroundSmoke([])).toBe(true);
    expect(requiresHmuxBackgroundSmoke(["bad\0path"])).toBe(true);
  });
});
