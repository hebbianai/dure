import { describe, expect, it } from "vitest";
import {
  isRunnerOwnedPath,
  KNOWN_CI_TARGET_PROFILES,
  planRunnerReclaim,
  profileEviction,
  RUNNER_DISK_POLICY,
  runnerDiskNeed,
  runnerStorageSatisfied,
  staleEntries,
  summarize,
} from "./runner-disk.mjs";

const GIB = 1024 ** 3;

const generation = (path, ageSeconds, bytes = 1024) => ({
  path,
  ageSeconds,
  bytes,
});

describe("isRunnerOwnedPath", () => {
  it("러너 work 루트 아래만 통과시킨다", () => {
    expect(isRunnerOwnedPath("/r/_work", "/r/_work/_temp/x")).toBe(true);
    expect(isRunnerOwnedPath("/r/_work/", "/r/_work/repo")).toBe(true);
  });

  it("루트 자신·바깥·상대경로 탈출을 거부한다", () => {
    for (const path of [
      "/r/_work",
      "/r",
      "/other/_work/x",
      "/r/_work/../secrets",
      "/r/_work//x",
    ]) {
      expect(isRunnerOwnedPath("/r/_work", path)).toBe(false);
    }
  });

  it("문자열이 아니면 거부한다", () => {
    expect(isRunnerOwnedPath("/r/_work", null)).toBe(false);
    expect(isRunnerOwnedPath(undefined, "/r/_work/x")).toBe(false);
  });
});

describe("profileEviction", () => {
  it("lease가 살아 있으면 아무것도 지우지 않는다", () => {
    const verdict = profileEviction({
      name: "verify",
      leased: true,
      generations: [generation("/p/a", 0), generation("/p/b", 999_999)],
    });
    expect(verdict.skipped).toBe("leased");
    expect(verdict.evict).toEqual([]);
  });

  it("scheduled GC는 오래된 lease도 죽었다고 추정하지 않는다", () => {
    const verdict = profileEviction({
      name: "verify",
      leased: true,
      generations: [generation("/p/new", 10), generation("/p/old", 20)],
    });
    expect(verdict).toEqual({ skipped: "leased", evict: [] });
  });

  it("최신 세대 하나는 남긴다 — 정리가 곧 전체 재빌드가 되면 안 된다", () => {
    const verdict = profileEviction({
      name: "verify",
      leased: false,
      generations: [
        generation("/p/newest", 5),
        generation("/p/mid", 50),
        generation("/p/oldest", 500),
      ],
    });
    expect(verdict.evict.map((entry) => entry.path)).toEqual([
      "/p/mid",
      "/p/oldest",
    ]);
  });

  it("보존 기간을 넘긴 세대는 expired로 표시한다", () => {
    const verdict = profileEviction({
      name: "verify",
      leased: false,
      generations: [
        generation("/p/newest", 5),
        generation("/p/ancient", RUNNER_DISK_POLICY.retentionSeconds + 1),
      ],
    });
    expect(verdict.evict[0].reason).toBe("expired");
  });

  it("워크플로가 사라진 프로파일은 최신 세대까지 전량 회수한다", () => {
    const verdict = profileEviction({
      name: "some-removed-workflow",
      leased: false,
      generations: [generation("/p/a", 1), generation("/p/b", 2)],
    });
    expect(verdict.evict).toHaveLength(2);
  });

  it("고아 판정도 lease보다 뒤에 온다 — 쓰이는 중이면 이름과 무관하다", () => {
    const verdict = profileEviction({
      name: "some-removed-workflow",
      leased: true,
      generations: [generation("/p/a", 1)],
    });
    expect(verdict.skipped).toBe("leased");
  });

  it("허용 목록은 manage-ci-cargo-target.sh와 같아야 한다", () => {
    // 두 곳이 어긋나면 살아 있는 캐시를 고아로 오인해 매번 전량 회수한다.
    expect([...KNOWN_CI_TARGET_PROFILES].sort()).toEqual(
      [
        "hmux-release-promotion",
        "hmux-release-trust",
        "linux-musl-artifacts",
        "verify",
        "windows-cross-target",
      ].sort(),
    );
  });
});

describe("runner root storage policy", () => {
  it("fixes both the free-space floor and aggregate Cargo cache budget", () => {
    expect(RUNNER_DISK_POLICY.floorBytes).toBe(60 * GIB);
    expect(RUNNER_DISK_POLICY.goalBytes).toBe(200 * GIB);
    expect(RUNNER_DISK_POLICY.cacheBudgetBytes).toBe(60 * GIB);
  });

  it("combines physical-space and root-cache deficits without double counting", () => {
    expect(
      runnerDiskNeed({
        availableBytes: 50 * GIB,
        totalCacheBytes: 75 * GIB,
      }),
    ).toEqual({
      cacheExcessBytes: 15 * GIB,
      freeSpaceNeedBytes: 150 * GIB,
      unknownSpace: false,
    });
    expect(
      runnerDiskNeed({
        availableBytes: 400 * GIB,
        totalCacheBytes: 75 * GIB,
      }),
    ).toEqual({
      cacheExcessBytes: 15 * GIB,
      freeSpaceNeedBytes: 0,
      unknownSpace: false,
    });
  });

  it("evicts inactive Cargo generations in LRU order for the root budget", () => {
    const candidates = [
      { ...generation("/cache/new", 10, 8 * GIB), category: "cargo-target" },
      { ...generation("/cache/old", 30, 8 * GIB), category: "cargo-target" },
      { ...generation("/work/stale", 100, 40 * GIB), category: "stale-repo" },
    ];
    const plan = planRunnerReclaim(candidates, {
      cacheExcessBytes: 8 * GIB,
      freeSpaceNeedBytes: 0,
    });
    expect(plan.selected.map((entry) => entry.path)).toEqual(["/cache/old"]);
    expect(plan.cacheSatisfied).toBe(true);
  });

  it("never claims a hard budget was met when active caches are not candidates", () => {
    const plan = planRunnerReclaim([], {
      cacheExcessBytes: 1,
      freeSpaceNeedBytes: 1,
    });
    expect(plan).toMatchObject({
      cacheSatisfied: false,
      floorSatisfied: false,
    });
  });

  it("fails closed when final free-space observation is unavailable", () => {
    expect(
      runnerStorageSatisfied({
        availableBytes: null,
        totalCacheBytes: 10 * GIB,
      }),
    ).toBe(false);
    expect(
      runnerStorageSatisfied({
        availableBytes: 100 * GIB,
        totalCacheBytes: 10 * GIB,
      }),
    ).toBe(true);
  });
});

describe("staleEntries", () => {
  it("오래 조용한 것만 고른다", () => {
    const entries = [
      { path: "/w/busy", ageSeconds: 60 },
      { path: "/w/idle", ageSeconds: RUNNER_DISK_POLICY.idleSeconds + 1 },
    ];
    expect(staleEntries(entries).map((entry) => entry.path)).toEqual(["/w/idle"]);
  });

  it("경계값은 지운다 (>=)", () => {
    expect(
      staleEntries([{ path: "/w/x", ageSeconds: RUNNER_DISK_POLICY.idleSeconds }]),
    ).toHaveLength(1);
  });
});

describe("summarize", () => {
  it("비어 있는 분류는 생략한다", () => {
    expect(summarize({ generations: [1, 2], orphans: [], temp: [3] })).toBe(
      "generations 2, temp 1",
    );
  });
});
