import { isHmuxTestOnlyPath } from "./hmux-test-only-path.mjs";

const NON_RUNTIME_PATH =
  /^(?:docs\/|hmux\/docs\/|public\/|README[^/]*$|AGENTS\.md$|\.claude\/|\.beads\/|\.githooks\/)/;
const FRONTEND_TEST_PATH = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const SCRIPT_TEST_PATH = /^scripts\/.+\.test\.mjs$/;
const SCRIPT_MODULE_PATH = /^scripts\/.+\.[cm]?js$/;
const CLI_CONTRACT_PATH = /^(?:cli\/dure\.mjs|cli\/lib\/.+\.[cm]?js)$/;
const NON_RUNTIME_EXACT_PATHS = new Set([
  "cli/README.md",
  "hmux/LICENSE",
  "hmux/README.md",
  "hmux/SOURCE_PROVENANCE.md",
  "mobile/README.md",
]);

// ipc.ts는 배럴이고 실제 구현은 src/lib/ipc/ 도메인 모듈로 분할됐다
// (2026-08-01). 터미널 전달 경로가 지나는 모듈(core invoke 플럼빙, 이벤트
// 구독, hmux 계약/런타임, 세션·스폰 수명주기)은 배럴과 같은 자격으로
// smoke를 요구한다 — 배럴만 남기면 구현 파일 직접 수정이 조용히 빠진다.
export const FRONTEND_RUNTIME_PATHS = new Set([
  "src/lib/ipc.ts",
  "src/lib/ipc/core.ts",
  "src/lib/ipc/sessions.ts",
  "src/lib/ipc/spawn.ts",
  "src/lib/platform/tauriBridge.ts",
  "src/lib/workspace/window/windows.ts",
  "src/main.tsx",
  "src/qa.ts",
  "src/store.ts",
]);

export const FRONTEND_RUNTIME_PREFIXES = [
  "src/components/terminal/",
  "src/lib/hmux",
  "src/lib/ipc/hmux",
  "src/lib/terminal",
  "src/qa/hmux",
];

function pathRequiresHmuxBackgroundSmoke(path) {
  if (NON_RUNTIME_PATH.test(path)) return false;
  if (NON_RUNTIME_EXACT_PATHS.has(path) || path.endsWith("/AGENTS.md")) {
    return false;
  }
  if (path.startsWith("mobile/")) return false;
  if (path === "src/qa.ts" || path.startsWith("src/qa/")) return false;
  if (path.startsWith("scripts/qa/")) return false;
  if (SCRIPT_TEST_PATH.test(path)) return false;
  if (SCRIPT_MODULE_PATH.test(path)) return false;
  if (CLI_CONTRACT_PATH.test(path)) return false;
  if (path.startsWith("tools/media-capture/")) return false;

  if (path.startsWith("src/")) {
    if (FRONTEND_TEST_PATH.test(path)) return false;
    return (
      FRONTEND_RUNTIME_PATHS.has(path) ||
      FRONTEND_RUNTIME_PREFIXES.some((prefix) => path.startsWith(prefix))
    );
  }

  if (path.startsWith("src-tauri/")) return true;
  if (path.startsWith("hmux/")) return !isHmuxTestOnlyPath(path);

  // Shared manifests, CI authority, and unknown paths remain fail-closed.
  return true;
}

export function requiresHmuxBackgroundSmoke(paths) {
  if (!Array.isArray(paths) || paths.length === 0) return true;
  for (const path of paths) {
    if (
      typeof path !== "string" ||
      path.length === 0 ||
      path.includes("\0") ||
      pathRequiresHmuxBackgroundSmoke(path)
    ) {
      return true;
    }
  }
  return false;
}
