import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectQuiesceBlockers,
  inspectMigrateHome,
  migrateHome,
} from "../cli/lib/migrate-home.mjs";

// disposable HOME 픽스처 — 인시던트 규칙: 실제 HOME을 만지는 사고 2회 전례.
// 모듈이 env를 읽지 않고 명시 home 인자만 쓰는 것이 이 격리의 전제이고,
// 모든 반환 경로가 픽스처 루트 아래인지도 단언한다.
const fixtures = [];
afterEach(() => {
  while (fixtures.length > 0) {
    rmSync(fixtures.pop(), { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
});

function fixtureHome() {
  const home = mkdtempSync(join(tmpdir(), "dure-migrate-home-"));
  fixtures.push(home);
  return home;
}

function seedLegacy(home, entries = { "agents.json": "{}\n" }) {
  const legacy = join(home, ".hebbian");
  mkdirSync(legacy);
  for (const [name, contents] of Object.entries(entries)) {
    writeFileSync(join(legacy, name), contents);
  }
  return legacy;
}

/** 결정적으로 죽은 pid — 짧게 살다 끝난 자식의 pid를 쓴다(재사용 창은
 *  테스트 수명(ms) 대비 무시 가능). 그냥 큰 수를 쓰면 EINVAL류가 fail-closed
 *  분기로 빠져 "죽음"을 검증하지 못한다. */
function exitedPid() {
  const child = spawnSync("true");
  return child.pid;
}

describe("inspectMigrateHome", () => {
  it("상태를 정확히 분류한다", () => {
    const home = fixtureHome();
    expect(inspectMigrateHome(home).state).toBe("nothing");
    seedLegacy(home);
    const inspected = inspectMigrateHome(home);
    expect(inspected.state).toBe("legacy_only");
    // 모든 해석 경로가 픽스처 아래여야 한다 — ambient 유출 금지.
    for (const path of Object.values(inspected.paths)) {
      expect(path.startsWith(home)).toBe(true);
    }
    mkdirSync(join(home, ".dure"));
    expect(inspectMigrateHome(home).state).toBe("conflict");
  });
});

describe("migrateHome preview", () => {
  it("아무것도 바꾸지 않고 계획과 차단자만 보고한다", () => {
    const home = fixtureHome();
    seedLegacy(home);
    mkdirSync(join(home, ".hebbian", "landing.lock"), { recursive: true });
    writeFileSync(join(home, ".hebbian", "landing.lock", "pid"), `${process.pid}\n`);
    const result = migrateHome(home, { apply: false });
    expect(result.applied).toBe(false);
    expect(result.blockers.length).toBeGreaterThan(0);
    expect(lstatSync(join(home, ".hebbian")).isDirectory()).toBe(true);
    expect(existsSync(join(home, ".dure"))).toBe(false);
    expect(existsSync(join(home, ".dure-migrate-journal.json"))).toBe(false);
  });
});

describe("migrateHome apply", () => {
  it("이동 + 호환 symlink + 검증까지, 옛 경로가 계속 동작한다", () => {
    const home = fixtureHome();
    seedLegacy(home, { "agents.json": `{"agents":[]}\n`, "orchestration.json": "{}\n" });
    const result = migrateHome(home, { apply: true });
    expect(result.applied).toBe(true);
    expect(readdirSync(join(home, ".dure"))).toContain("agents.json");
    const link = lstatSync(join(home, ".hebbian"));
    expect(link.isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(home, ".hebbian"))).toBe(".dure");
    // 옛 절대경로로 읽기 — 미치환 스크립트 호환의 핵심.
    expect(readFileSync(join(home, ".hebbian", "agents.json"), "utf8")).toBe(
      `{"agents":[]}\n`,
    );
  });

  it("재실행은 no-op이다 (idempotent)", () => {
    const home = fixtureHome();
    seedLegacy(home);
    migrateHome(home, { apply: true });
    const again = migrateHome(home, { apply: true });
    expect(again.state).toBe("already_migrated");
    expect(again.applied).toBe(false);
  });

  it("살아있는 검증 락 보유자가 있으면 apply를 거부한다", () => {
    const home = fixtureHome();
    seedLegacy(home);
    const locks = join(home, ".hebbian", "full-verification-locks");
    mkdirSync(locks, { recursive: true });
    writeFileSync(
      join(locks, "a.lock.1.owner"),
      `${JSON.stringify({ pid: process.pid, worktree: "/w" })}\n`,
    );
    expect(() => migrateHome(home, { apply: true })).toThrow();
    expect(lstatSync(join(home, ".hebbian")).isDirectory()).toBe(true);
  });

  it("죽은 보유자만 있으면 이동한다", () => {
    const home = fixtureHome();
    seedLegacy(home);
    const locks = join(home, ".hebbian", "full-verification-locks");
    mkdirSync(locks, { recursive: true });
    writeFileSync(
      join(locks, "a.lock.1.owner"),
      `${JSON.stringify({ pid: exitedPid(), worktree: "/w" })}\n`,
    );
    expect(migrateHome(home, { apply: true }).applied).toBe(true);
  });

  it("양쪽 다 실제 디렉터리면 병합하지 않고 거부한다", () => {
    const home = fixtureHome();
    seedLegacy(home);
    mkdirSync(join(home, ".dure"));
    writeFileSync(join(home, ".dure", "keep.txt"), "x");
    expect(() => migrateHome(home, { apply: true })).toThrow();
    expect(readFileSync(join(home, ".dure", "keep.txt"), "utf8")).toBe("x");
    expect(lstatSync(join(home, ".hebbian")).isDirectory()).toBe(true);
  });

  it("다른 마이그레이션이 락을 쥐고 있으면 거부한다", () => {
    const home = fixtureHome();
    seedLegacy(home);
    mkdirSync(join(home, ".dure-migrate.lock"));
    writeFileSync(join(home, ".dure-migrate.lock", "pid"), `${process.pid}\n`);
    expect(() => migrateHome(home, { apply: true })).toThrow();
  });
});

describe("crash resume (fault injection)", () => {
  it("rename 직후 중단 → 재실행이 symlink만 마저 만든다", () => {
    const home = fixtureHome();
    // 중단 상태 재현: .dure만 있고 저널이 moved를 증언한다.
    mkdirSync(join(home, ".dure"));
    writeFileSync(join(home, ".dure", "agents.json"), "{}\n");
    writeFileSync(
      join(home, ".dure-migrate-journal.json"),
      `${JSON.stringify({
        schema: "dure-migrate-home-journal/v1",
        step: "moved",
        inventory: ["agents.json"],
      })}\n`,
    );
    const result = migrateHome(home, { apply: true });
    expect(result.state).toBe("resume_symlink");
    expect(result.applied).toBe(true);
    expect(readlinkSync(join(home, ".hebbian"))).toBe(".dure");
  });

  it("저널 증거 없는 .dure 단독은 이어가지 않는다 — 수동 확인 요구", () => {
    const home = fixtureHome();
    mkdirSync(join(home, ".dure"));
    expect(() => migrateHome(home, { apply: true })).toThrow();
    expect(existsSync(join(home, ".hebbian"))).toBe(false);
  });
});

describe("collectQuiesceBlockers", () => {
  it("판독 불가한 dev-deploy.lock은 fail-closed로 막는다", () => {
    const home = fixtureHome();
    seedLegacy(home);
    mkdirSync(join(home, ".hebbian", "dev-deploy.lock"));
    const blockers = collectQuiesceBlockers(home);
    expect(blockers.some((b) => b.includes("dev-deploy.lock"))).toBe(true);
  });

  it("잘못된 symlink 상태는 conflict로 분류된다", () => {
    const home = fixtureHome();
    mkdirSync(join(home, ".dure"));
    symlinkSync(join(home, "elsewhere"), join(home, ".hebbian"));
    expect(inspectMigrateHome(home).state).toBe("conflict");
  });

  it("상대 legacy symlink도 같은 canonical root로 판정한다", () => {
    const home = fixtureHome();
    mkdirSync(join(home, ".dure"));
    symlinkSync(".dure", join(home, ".hebbian"));
    expect(inspectMigrateHome(home).state).toBe("already_migrated");
  });
});
