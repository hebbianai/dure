import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI = join(
  dirname(fileURLToPath(import.meta.url)),
  "runner-disk-maintenance.mjs",
);
const DAY = 24 * 3600;

let work;

/** 나이는 mtime으로 준다 — 스크립트가 보는 것과 같은 신호다.
 *
 *  만든 경로의 **모든 단계**에 같은 나이를 준다. 잎에만 주면 현실과 다른
 *  픽스처가 된다: 실제로 버려진 작업 폴더는 위아래가 같이 낡고, 쓰이는 중인
 *  폴더는 안쪽이 새것이다. 스크립트도 그 차이(가장 최근 수정)를 본다. */
function make(relative, ageSeconds) {
  const path = join(work, relative);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "payload"), "x".repeat(4096));
  const when = Date.now() / 1000 - ageSeconds;
  const segments = relative.split("/");
  for (let depth = segments.length; depth >= 1; depth -= 1) {
    utimesSync(join(work, ...segments.slice(0, depth)), when, when);
  }
  return path;
}

function run(...args) {
  return execFileSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      RUNNER_WORK: work,
      // GitHub의 self-hosted runner가 주입하는 값과 충돌해도 픽스처의 명시적
      // root가 이겨야 한다. 실제 CI root를 읽거나 지우는 회귀를 닫는다.
      RUNNER_WORKSPACE: join(work, "ambient-runner", "repository"),
      GITHUB_WORKSPACE: join(work, "ambient-github", "repository", "repository"),
    },
  });
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "runner-work-"));
});

afterEach(() => {
  rmSync(work, { force: true, recursive: true });
});

describe("runner-disk-maintenance", () => {
  it.each(["RUNNER_WORK", "RUNNER_WORKSPACE", "GITHUB_WORKSPACE"])("preserves paths outside the physical root for %s with a symlink checkout", (rootVariable) => {
    const unrelatedStale = make("lexical-work/OldRepoName/OldRepoName", 30 * DAY);
    const unrelatedCache = make("lexical-work/_hebbian-ci-targets-v1/removed-workflow/aaa", 60);
    const checkout = make("physical-work/checkout", 60);
    make("physical-work/checkout/source", 60);
    const stale = make("physical-work/OldRepoName/OldRepoName", 30 * DAY);
    const orphan = make("physical-work/_hebbian-ci-targets-v1/removed-workflow/aaa", 60);
    make("physical-work/_hebbian-ci-targets-v1/verify/.lease", 30 * DAY);
    const leased = make("physical-work/_hebbian-ci-targets-v1/verify/aaa", 30 * DAY);
    symlinkSync(checkout, join(work, "lexical-work/dure-internal"), "dir");
    const suppliedRoot = `${work}/lexical-work/dure-internal/..`;
    expect(realpathSync.native(suppliedRoot)).toBe(realpathSync.native(join(work, "physical-work")));
    const rootInputs = {
      RUNNER_WORK: suppliedRoot,
      RUNNER_WORKSPACE: join(work, "lexical-work/dure-internal"),
      GITHUB_WORKSPACE: join(work, "lexical-work/dure-internal/source"),
    };

    execFileSync(process.execPath, [CLI, "--apply", "--all"], {
      encoding: "utf8",
      env: {
        ...process.env,
        RUNNER_WORK: undefined,
        RUNNER_WORKSPACE: undefined,
        GITHUB_WORKSPACE: undefined,
        [rootVariable]: rootInputs[rootVariable],
        GITHUB_STEP_SUMMARY: "",
      },
    });

    expect(existsSync(unrelatedStale)).toBe(true);
    expect(existsSync(unrelatedCache)).toBe(true);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(checkout)).toBe(true);
    expect(existsSync(leased)).toBe(true);
  });

  it("reclaims through the workflow parent-directory root while preserving active resources", () => {
    const fresh = make("dure-internal/dure-internal", 60);
    const stale = make("OldRepoName/OldRepoName", 30 * DAY);
    make("_hebbian-ci-targets-v1/verify/.lease", 30 * DAY);
    const leased = make("_hebbian-ci-targets-v1/verify/aaa", 30 * DAY);
    const orphan = make("_hebbian-ci-targets-v1/removed-workflow/aaa", 60);

    execFileSync(process.execPath, [CLI, "--apply", "--all"], {
      encoding: "utf8",
      env: {
        ...process.env,
        RUNNER_WORK: `${work}/dure-internal/..`,
        RUNNER_WORKSPACE: join(work, "ambient-runner", "repository"),
        GITHUB_WORKSPACE: join(work, "ambient-github", "repository", "repository"),
        GITHUB_STEP_SUMMARY: "",
      },
    });

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(leased)).toBe(true);
  });

  it("scheduled GC는 오래된 lease도 건드리지 않는다", () => {
    // 나이 기반 liveness 추정은 긴 정상 job을 지울 수 있다. 다음 serial
    // prepare만 stale lease를 판정하고 maintenance는 존재 자체를 보호한다.
    make("_hebbian-ci-targets-v1/verify/.lease", 30 * DAY);
    const newest = make("_hebbian-ci-targets-v1/verify/aaa", 10);
    const older = make("_hebbian-ci-targets-v1/verify/bbb", 30 * DAY);

    const output = run("--apply", "--all", "--floor=999999", "--goal=999999");

    expect(output).toContain("skip(leased)");
    expect(existsSync(newest)).toBe(true);
    expect(existsSync(older)).toBe(true);
  });

  it("최신 세대는 남기고 오래된 세대만 회수한다", () => {
    const newest = make("_hebbian-ci-targets-v1/verify/aaa", 60);
    const older = make("_hebbian-ci-targets-v1/verify/bbb", 30 * DAY);

    // Retention applies after storage needs are met. Keep this tiny fixture
    // above its own goal instead of inheriting the host's 200 GiB requirement.
    run("--apply", "--all", "--floor=0.001", "--goal=0.001");

    expect(existsSync(newest)).toBe(true);
    expect(existsSync(older)).toBe(false);
  });

  it("reclaims the newest unleased generation when free-space demand remains", () => {
    const newest = make("_hebbian-ci-targets-v1/verify/aaa", 60);
    const older = make("_hebbian-ci-targets-v1/verify/bbb", 30 * DAY);

    run("--apply", "--all", "--floor=999999", "--goal=999999");

    expect(existsSync(newest)).toBe(false);
    expect(existsSync(older)).toBe(false);
  });

  it("워크플로가 사라진 프로파일은 최신 세대까지 회수한다", () => {
    const orphan = make("_hebbian-ci-targets-v1/removed-workflow/aaa", 60);

    run("--apply", "--all");

    expect(existsSync(orphan)).toBe(false);
  });

  it("오래 조용한 저장소 작업 폴더는 회수하고, 최근 것은 남긴다", () => {
    const stale = make("OldRepoName/OldRepoName", 30 * DAY);
    const fresh = make("dure-internal/dure-internal", 60);

    run("--apply", "--all");

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it("툴체인 캐시와 러너 내부 상태는 후보에 올리지 않는다", () => {
    // 지워도 다음 job이 다시 받으므로 이득이 없고, 그동안 러너만 느려진다.
    const tool = make("_tool/node/24.13.0", 90 * DAY);
    const mapping = make("_PipelineMapping/x", 90 * DAY);

    run("--apply", "--all");

    expect(existsSync(tool)).toBe(true);
    expect(existsSync(mapping)).toBe(true);
  });

  it("기본은 dry-run — 아무것도 지우지 않는다", () => {
    const orphan = make("_hebbian-ci-targets-v1/removed-workflow/aaa", 60);

    const output = run("--all");

    expect(output).toContain("회수 예정");
    expect(existsSync(orphan)).toBe(true);
  });

  it("여유가 목표 위면 회수하지 않는다", () => {
    // 하한/목표를 0에 가깝게 두면 필요량이 0이라 계획이 비어야 한다.
    const orphan = make("_hebbian-ci-targets-v1/removed-workflow/aaa", 60);

    const output = run("--apply", "--floor=0.001", "--goal=0.001");

    expect(existsSync(orphan)).toBe(true);
    expect(output).toContain("회수 완료         0개");
  });

  it("--require-floor는 정리 후에도 부족하면 실패로 알린다", () => {
    // 하한을 디스크보다 크게 잡아 '아직 부족한' 상태를 만든다.
    expect(() =>
      run("--apply", "--require-floor", "--floor=999999", "--goal=999999"),
    ).toThrow(/하한 아래/);
  });
});
