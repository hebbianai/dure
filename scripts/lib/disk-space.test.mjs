import { describe, expect, it } from "vitest";
import {
  BUILD_STORAGE_BUDGETS,
  buildOutputEligibility,
  buildStorageBudget,
  DEFAULT_FLOOR_BYTES,
  DEFAULT_GOAL_BYTES,
  DEFAULT_LOCAL_CACHE_BUDGET_BYTES,
  formatBytes,
  GIB,
  isBuildOutputPath,
  isolatedBuildOutputEligibility,
  parseDfAvailableBytes,
  planReclaim,
  reclaimNeed,
  storageReclaimNeed,
} from "./disk-space.mjs";

const MACOS_DF = `Filesystem  1024-blocks       Used Available Capacity iused      ifree %iused  Mounted on
/dev/disk3s5 1942700360 1941905560    394800   100%  15000000 4000000   79%   /System/Volumes/Data`;

const LINUX_DF = `Filesystem     1K-blocks      Used Available Use% Mounted on
/dev/nvme0n1p2 982940000 400000000 532940000  43% /`;

// 장치 이름이 길면 Linux df는 데이터 행을 줄바꿈한다.
const LINUX_DF_WRAPPED = `Filesystem                                    1K-blocks      Used Available Use% Mounted on
/dev/mapper/very--long--volume--group-root--lv
                                              982940000 400000000 532940000  43% /`;

describe("parseDfAvailableBytes", () => {
  it("macOS 형식에서 available 컬럼을 읽는다", () => {
    expect(parseDfAvailableBytes(MACOS_DF)).toBe(394800 * 1024);
  });

  it("Linux 형식에서 available 컬럼을 읽는다", () => {
    expect(parseDfAvailableBytes(LINUX_DF)).toBe(532940000 * 1024);
  });

  it("줄바꿈된 장치 이름을 이어 붙여 읽는다", () => {
    expect(parseDfAvailableBytes(LINUX_DF_WRAPPED)).toBe(532940000 * 1024);
  });

  it("읽을 수 없으면 null — 측정 실패가 빌드를 막지 않는다", () => {
    expect(parseDfAvailableBytes("")).toBeNull();
    expect(parseDfAvailableBytes("df: /nope: No such file or directory")).toBeNull();
    expect(parseDfAvailableBytes(undefined)).toBeNull();
  });
});

describe("reclaimNeed", () => {
  it("floor 아래면 목표까지의 부족분을 낸다", () => {
    const need = reclaimNeed({
      availBytes: 10 * GIB,
      floorBytes: 50 * GIB,
      goalBytes: 200 * GIB,
    });
    expect(need.belowFloor).toBe(true);
    expect(need.needBytes).toBe(190 * GIB);
  });

  it("floor 위면 회수하지 않는다", () => {
    const need = reclaimNeed({
      availBytes: 400 * GIB,
      floorBytes: 50 * GIB,
      goalBytes: 200 * GIB,
    });
    expect(need.belowFloor).toBe(false);
    expect(need.needBytes).toBe(0);
  });

  it("goal이 floor보다 작게 들어와도 floor를 목표로 삼는다", () => {
    const need = reclaimNeed({
      availBytes: 10 * GIB,
      floorBytes: 50 * GIB,
      goalBytes: 20 * GIB,
    });
    expect(need.needBytes).toBe(40 * GIB);
  });

  it("공간을 못 읽으면 fail-open — belowFloor는 false, unknown은 true", () => {
    const need = reclaimNeed({ availBytes: null });
    expect(need).toEqual({ belowFloor: false, needBytes: 0, unknown: true });
  });

  it("기본 floor는 최악의 전체 빌드 뒤에도 한 번분의 여유를 남긴다", () => {
    // A full build measures 25-50GiB across hmux/target + src-tauri/target, so
    // the floor covers one more worst-case build after the admitted one.
    expect(DEFAULT_FLOOR_BYTES).toBe(60 * GIB);
  });

  it("reclaims to twice the floor so the next build does not re-trigger GC", () => {
    // Reclaim buys headroom for a second build; a goal far above that would
    // delete every landed worktree on the host for one admission.
    expect(DEFAULT_GOAL_BYTES).toBe(2 * DEFAULT_FLOOR_BYTES);
  });

  it("keeps a dev build admissible on a volume that holds one full build", () => {
    // The regression this pins: floor + budget once exceeded the free space a
    // 926GB host ever has, so `pnpm app:dev:deploy` could never relaunch.
    expect(DEFAULT_FLOOR_BYTES + buildStorageBudget("dev")).toBeLessThan(
      100 * GIB,
    );
  });
});

describe("buildStorageBudget", () => {
  it("fixes one worst-case budget per reusable execution class", () => {
    expect(BUILD_STORAGE_BUDGETS).toEqual({
      frontend: 10 * GIB,
      cli: 4 * GIB,
      mobile: 35 * GIB,
      full: 50 * GIB,
      qa: 50 * GIB,
      dev: 20 * GIB,
    });
    expect(buildStorageBudget("frontend")).toBe(10 * GIB);
    expect(buildStorageBudget("full")).toBe(50 * GIB);
  });

  it("fails closed when a caller invents a second budget name", () => {
    expect(() => buildStorageBudget("desktop-ish")).toThrow(
      "unknown build storage budget",
    );
    // `rust` promised a whole-workspace budget but only ever admitted the
    // one-package CLI control-plane build. Retiring the name makes a caller
    // that meant the workspace fail loudly instead of under-booking silently.
    expect(() => buildStorageBudget("rust")).toThrow(
      "unknown build storage budget",
    );
  });
});

describe("storageReclaimNeed", () => {
  it("fixes the local cache total independently from the free-space floor", () => {
    expect(DEFAULT_LOCAL_CACHE_BUDGET_BYTES).toBe(600 * GIB);
    expect(
      storageReclaimNeed({
        availBytes: 400 * GIB,
        totalCacheBytes: 650 * GIB,
      }),
    ).toMatchObject({
      belowFloor: false,
      cacheExcessBytes: 50 * GIB,
      freeSpaceNeedBytes: 0,
      needBytes: 50 * GIB,
      overCacheBudget: true,
    });
  });

  it("deletes each byte only once when floor and cache pressure overlap", () => {
    // The larger of the two pressures, never their sum: the same bytes satisfy
    // both the free-space goal and the cache budget.
    expect(
      storageReclaimNeed({
        availBytes: 50 * GIB,
        totalCacheBytes: 650 * GIB,
      }).needBytes,
    ).toBe(DEFAULT_GOAL_BYTES - 50 * GIB);
  });
});

describe("buildOutputEligibility", () => {
  it("랜딩 완료 + clean + 유휴는 safe 단계로 지운다", () => {
    expect(
      buildOutputEligibility({ landed: true, dirty: false, hasLiveProcess: false }),
    ).toEqual({ eligible: true, reason: "landed-clean-idle", tier: "safe" });
  });

  it("빌드 중이면 어떤 단계에서도 지우지 않는다", () => {
    expect(
      buildOutputEligibility({
        hasLiveBuild: true,
        landed: true,
        aggressive: true,
      }),
    ).toEqual({ eligible: false, reason: "building" });
  });

  it("호출자 자기 워크트리는 지우지 않는다", () => {
    expect(
      buildOutputEligibility({
        isCurrentWorktree: true,
        landed: true,
        aggressive: true,
      }),
    ).toEqual({ eligible: false, reason: "current-worktree" });
  });

  it("보호 목록(daily driver 등)은 지우지 않는다", () => {
    expect(
      buildOutputEligibility({ isProtected: true, landed: true, aggressive: true }),
    ).toEqual({ eligible: false, reason: "protected" });
  });

  it("자동 GC는 미랜딩·dirty·사용 중을 각각의 이유로 건너뛴다", () => {
    expect(buildOutputEligibility({ landed: false }).reason).toBe("unlanded");
    expect(buildOutputEligibility({ landed: true, dirty: true }).reason).toBe("dirty");
    expect(
      buildOutputEligibility({ landed: true, hasLiveProcess: true }).reason,
    ).toBe("live-process");
  });

  it("aggressive는 idle 워크트리의 미랜딩·dirty만 덮어쓴다", () => {
    for (const input of [{ landed: false }, { landed: true, dirty: true }]) {
      const verdict = buildOutputEligibility({ ...input, aggressive: true });
      expect(verdict.eligible).toBe(true);
      expect(verdict.tier).toBe("aggressive");
    }
  });

  it("aggressive도 살아 있는 세션 프로세스의 target을 지우지 않는다", () => {
    expect(
      buildOutputEligibility({
        landed: true,
        hasLiveProcess: true,
        aggressive: true,
      }),
    ).toEqual({ eligible: false, reason: "live-process" });
  });

  it("aggressive도 Dure session이 참조하는 target을 지우지 않는다", () => {
    expect(
      buildOutputEligibility({
        landed: true,
        isSessionReferenced: true,
        aggressive: true,
      }),
    ).toEqual({ eligible: false, reason: "session-referenced" });
  });

  it("exact isolated transaction은 Git 휴리스틱 없이 수렴한다", () => {
    expect(isolatedBuildOutputEligibility({})).toEqual({
      eligible: true,
      reason: "isolated-transaction",
      tier: "recovery",
    });
    expect(
      isolatedBuildOutputEligibility({ hasLiveProcess: true }).reason,
    ).toBe("live-process");
    expect(
      isolatedBuildOutputEligibility({ hasLiveProcess: true, aggressive: true }),
    ).toEqual({ eligible: false, reason: "live-process" });
    expect(
      isolatedBuildOutputEligibility({ isProtected: true, aggressive: true })
        .reason,
    ).toBe("protected");
    expect(
      isolatedBuildOutputEligibility({
        isSessionReferenced: true,
        aggressive: true,
      }).reason,
    ).toBe("session-referenced");
  });
});

describe("planReclaim", () => {
  const candidates = [
    { path: "/r/.worktrees/a/hmux/target", bytes: 10 * GIB },
    { path: "/r/.worktrees/b/hmux/target", bytes: 40 * GIB },
    { path: "/r/.worktrees/c/hmux/target", bytes: 25 * GIB },
  ];

  it("큰 것부터 골라 필요량만 채운다", () => {
    const plan = planReclaim(candidates, 50 * GIB);
    expect(plan.selected.map((entry) => entry.bytes)).toEqual([40 * GIB, 25 * GIB]);
    expect(plan.satisfied).toBe(true);
  });

  it("전량 회수 모드", () => {
    expect(planReclaim(candidates, null).selected).toHaveLength(3);
    expect(planReclaim(candidates, Infinity).freedBytes).toBe(75 * GIB);
  });

  it("다 지워도 부족하면 satisfied=false로 알린다", () => {
    const plan = planReclaim(candidates, 500 * GIB);
    expect(plan.selected).toHaveLength(3);
    expect(plan.satisfied).toBe(false);
  });

  it("필요량이 0이면 아무것도 고르지 않는다", () => {
    expect(planReclaim(candidates, 0).selected).toEqual([]);
  });

  it("같은 크기는 경로 순 — 같은 입력이 같은 계획을 낸다", () => {
    const tie = [
      { path: "/r/z/target", bytes: 5 * GIB },
      { path: "/r/a/target", bytes: 5 * GIB },
    ];
    expect(planReclaim(tie, null).selected.map((entry) => entry.path)).toEqual([
      "/r/a/target",
      "/r/z/target",
    ]);
  });
});

describe("isBuildOutputPath", () => {
  const root = "/repo";

  it("빌드 산출물 경로를 통과시킨다", () => {
    for (const path of [
      "/repo/hmux/target",
      "/repo/src-tauri/target",
      "/repo/.worktrees/x/mobile/src-tauri/target",
      "/repo/.worktrees/x/crates/hebbian-app/target",
    ]) {
      expect(isBuildOutputPath(root, path)).toBe(true);
    }
  });

  it("루트·소스 디렉터리·저장소 밖·상대경로 탈출을 거부한다", () => {
    for (const path of [
      "/repo",
      "/repo/src",
      "/repo/.worktrees/x",
      "/repo/.worktrees/x/src",
      "/other/hmux/target",
      "/repo/../target",
      "/repo/.worktrees/../target",
      "/repo/hmux//target",
    ]) {
      expect(isBuildOutputPath(root, path)).toBe(false);
    }
  });

  it("중첩 target은 거부한다 — 탐색이 잘못됐다는 신호다", () => {
    expect(isBuildOutputPath(root, "/repo/hmux/target/debug/target")).toBe(false);
  });

  it("발견된 워크트리를 기준으로 봉쇄한다 — 저장소 루트 밖 워크트리도 자기 안에서는 허용", () => {
    // 회수는 "이 target 이 우리가 적격 판정한 워크트리 것"임을 보장해야 한다.
    // 메인 체크아웃 기준으로 보면 임시 디렉터리 워크트리는 전부 거부되어,
    // 계획에는 올라가고 실행은 안 되는 상태가 된다(2026-08-20 회귀).
    expect(
      isBuildOutputPath("/private/tmp/dure-fixture", "/private/tmp/dure-fixture/hmux/target"),
    ).toBe(true);
    expect(
      isBuildOutputPath("/repo", "/private/tmp/dure-fixture/hmux/target"),
    ).toBe(false);
    // 워크트리 기준이어도 탈출·중첩 방어는 그대로다.
    expect(
      isBuildOutputPath("/private/tmp/dure-fixture", "/private/tmp/dure-fixture/../other/target"),
    ).toBe(false);
    expect(
      isBuildOutputPath(
        "/private/tmp/dure-fixture",
        "/private/tmp/dure-fixture/hmux/target/debug/target",
      ),
    ).toBe(false);
  });

  it("루트 끝의 슬래시를 흡수한다", () => {
    expect(isBuildOutputPath("/repo/", "/repo/hmux/target")).toBe(true);
  });

  it("문자열이 아니면 거부한다", () => {
    expect(isBuildOutputPath(root, undefined)).toBe(false);
    expect(isBuildOutputPath(undefined, "/repo/hmux/target")).toBe(false);
  });
});

describe("formatBytes", () => {
  it("GiB와 MiB를 구분해 쓴다", () => {
    expect(formatBytes(2.5 * GIB)).toBe("2.5 GiB");
    expect(formatBytes(300 * 1024 * 1024)).toBe("300 MiB");
    expect(formatBytes(NaN)).toBe("?");
  });
});
