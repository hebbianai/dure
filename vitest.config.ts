// SPDX-License-Identifier: GPL-3.0-only

import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";
import {
  DEADLINE_SENSITIVE_PROCESS_TEST_PATHS,
  NODE_TEST_PATHS,
  PROCESS_FIXTURE_TEST_PATHS,
} from "./scripts/lib/script-test-projects.mjs";

const EXCLUDE = ["**/.worktrees/**", "**/.claude-worktrees/**"];

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    // Report release failures as cases finish, retaining GitHub annotations.
    ...(process.env.DURE_RELEASE_VERIFICATION_ROOT
      ? {
          reporters: [
            "verbose" as const,
            ...(process.env.GITHUB_ACTIONS === "true"
              ? ["github-actions" as const]
              : []),
          ],
        }
      : {}),
    // Several fixture suites spawn Git, shell, and process-group children. Let
    // Vitest use only half the logical CPUs so those children can make progress
    // under shared-host contention without weakening the 5s test deadline.
    maxWorkers: "50%",
    exclude: EXCLUDE,
    // 두 종류의 테스트는 작업량이 다르므로 데드라인도 다르다.
    //
    // src/**: 순수 모듈·컴포넌트 단위 테스트. 5초(Vitest 기본)를 넘기면 그건
    // 느린 CI가 아니라 테스트가 잘못 설계된 것이다 — 이 규율은 유지한다.
    //
    // scripts/**: node CLI·git·매니저 스크립트·PTY 픽스처를 실제로 spawn하는
    // 통합 테스트. 로컬에서도 케이스당 1~5초가 정상이고, 공유 CI 러너의 경합
    // 아래서는 그 위로 넘어간다. 2026-07-30 main CI red이 이것이었다:
    // deploy-dev-app·ci-cargo-target-cache·hmux-remote-soak에서 "Test timed
    // out in 5000ms"만 10건 — 세 파일 모두 프로세스를 띄우는 스위트다.
    // 파일마다 timeout을 붙이면 새로 추가되는 스크립트 스위트에서 같은 red가
    // 반복되므로 층에서 한 번 정한다. hookTimeout도 함께 올린다 — 픽스처
    // 생성(git init, 원격 클론)이 같은 spawn 비용을 낸다.
    //
    // 60초의 근거: verify job은 vitest를 nice로 낮춰 cargo 빌드와 같은 러너에서
    // 경합시킨다(ci.yml). 그 아래서 ci-cargo-target-cache의 한 케이스가 로컬
    // 0.8초 → CI 20초 초과로 관측됐다(25배). 스크립트 스위트는 전체 런타임의
    // 소수이므로, 진짜 hang을 늦게 잡는 비용보다 경합으로 red가 되는 비용이
    // 크다. 개별 test(..., timeout)로 이 값을 낮추지 말 것 — 층보다 낮은
    // 오버라이드가 조용히 우선해 같은 red를 만든다(53a6b5e1이 그 사례).
    projects: [
      {
        extends: true,
        test: {
          name: "src",
          include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
          exclude: EXCLUDE,
          setupFiles: ["./src/test/setup.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "scripts",
          include: ["scripts/**/*.test.mjs"],
          exclude: [
            ...EXCLUDE,
            ...NODE_TEST_PATHS,
            ...DEADLINE_SENSITIVE_PROCESS_TEST_PATHS,
            ...PROCESS_FIXTURE_TEST_PATHS,
          ],
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
      {
        extends: true,
        test: {
          name: "scripts-deadline",
          include: DEADLINE_SENSITIVE_PROCESS_TEST_PATHS,
          exclude: EXCLUDE,
          // These suites assert user-visible 1.5-2.5s deadlines. Run one file
          // at a time so sibling child-process fixtures cannot consume the
          // deadline they are meant to measure. The deadlines stay strict.
          maxWorkers: 1,
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
      {
        extends: true,
        test: {
          name: "scripts-process",
          include: PROCESS_FIXTURE_TEST_PATHS,
          exclude: EXCLUDE,
          // Each file already bounds its own useful concurrency. The script
          // runner gives every file a separate Vitest invocation so unrelated
          // Git remotes and process-ownership fixtures never overlap.
          maxWorkers: 1,
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
