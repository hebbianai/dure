// `dure doctor migrate-home` — `~/.hebbian` → `~/.dure` 실제 이동.
//
// Migration invariants:
// - preview가 기본이고 --apply만 디스크를 만진다 (fail-closed 마이그레이션).
// - 모든 경로는 **명시된 home 인자**에서 해석한다 — env를 읽으면 disposable
//   HOME 픽스처에 ambient 환경이 새어든다(인시던트 규칙 2건).
// - 파괴적 경계(rename) 전에 저널을 먼저 쓴다. 중단돼도 재실행이 저널과 실제
//   상태를 대조해 남은 단계(symlink)만 마저 한다 — 절대 되돌아가 다시 옮기지
//   않는다.
// - liveness는 죽음 방향만 결정적: kill(0)의 ESRCH만 "죽음"이고, EPERM 등
//   그 외 관찰 실패는 전부 살아있다고 보고 막는다(fail-closed).
// - rename은 동일 볼륨 원자 연산이라 롤백도 rename 한 번이다. 데이터를
//   복사·삭제하는 경로는 아예 없다.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export const LEGACY_DIR = ".hebbian";
export const RENAMED_DIR = ".dure";
const LOCK_DIR = ".dure-migrate.lock";
const JOURNAL_FILE = ".dure-migrate-journal.json";
const JOURNAL_SCHEMA = "dure-migrate-home-journal/v1";

/** kill(0) 기반 liveness — ESRCH만 결정적 죽음. 그 외 실패는 fail-closed. */
function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** Symlink payloads may be relative (`.dure`) or absolute. Compare the paths
 * they resolve to instead of comparing the raw link text. This is deliberately
 * lexical: the target must remain inside the explicitly supplied HOME even
 * when the link is inspected before the target exists. */
function symlinkTargets(linkPath, expectedTarget) {
  try {
    return (
      resolve(dirname(linkPath), readlinkSync(linkPath)) === resolve(expectedTarget)
    );
  } catch {
    return false;
  }
}

/** 이동을 막아야 하는 살아있는 사용자 목록. 각 항목은 사람이 읽을 한 줄. */
export function collectQuiesceBlockers(home) {
  const legacy = join(home, LEGACY_DIR);
  const blockers = [];

  // 1) 머신 공용 랜딩 락 — 디렉터리 + pid 파일 (pre-push 훅과 같은 계약).
  const landingPidFile = join(legacy, "landing.lock", "pid");
  if (existsSync(join(legacy, "landing.lock"))) {
    let pid;
    try {
      pid = Number.parseInt(readFileSync(landingPidFile, "utf8").trim(), 10);
    } catch {
      pid = undefined;
    }
    if (pid === undefined || processAlive(pid)) {
      blockers.push(
        `The landing.lock holder${pid === undefined ? " (PID not recorded)" : ` pid=${pid}`} is active`,
      );
    }
  }

  // 2) 검증 락 owner 파일들 — {pid} JSON (full-verification-lock 계약).
  const verificationRoot = join(legacy, "full-verification-locks");
  if (existsSync(verificationRoot)) {
    for (const entry of readdirSync(verificationRoot)) {
      if (!entry.endsWith(".owner")) continue;
      const owner = readJson(join(verificationRoot, entry));
      const pid = owner?.pid;
      if (typeof pid !== "number" || processAlive(pid)) {
        blockers.push(
          `Verification lock holder pid=${pid ?? "?"} (${owner?.worktree ?? entry}) is active`,
        );
      }
    }
  }

  // 3) dev-deploy 락 — 형태를 강하게 가정하지 않는다: 존재하면 pid를 찾아보고,
  //    못 읽으면 fail-closed로 막는다.
  const deployLock = join(legacy, "dev-deploy.lock");
  if (existsSync(deployLock)) {
    const stat = lstatSync(deployLock);
    const pidSource = stat.isDirectory() ? join(deployLock, "pid") : deployLock;
    let pid;
    try {
      const text = readFileSync(pidSource, "utf8").trim();
      pid = Number.parseInt(
        text.startsWith("{") ? String(JSON.parse(text).pid) : text,
        10,
      );
    } catch {
      pid = undefined;
    }
    if (pid === undefined || Number.isNaN(pid) || processAlive(pid)) {
      blockers.push("dev-deploy.lock exists (deployment is in progress or the lock could not be read)");
    }
  }

  return blockers;
}

/** 현재 디스크 상태 → 어떤 단계가 남았는지. 순수 관찰(무변경). */
export function inspectMigrateHome(home) {
  const legacy = join(home, LEGACY_DIR);
  const renamed = join(home, RENAMED_DIR);
  const stat = (path) => {
    try {
      return lstatSync(path);
    } catch {
      return undefined;
    }
  };
  const legacyStat = stat(legacy);
  const renamedStat = stat(renamed);
  const paths = { home, legacy, renamed, journal: join(home, JOURNAL_FILE) };

  if (renamedStat?.isDirectory()) {
    if (!legacyStat) {
      // rename 직후 중단된 상태 — symlink만 남았다 (crash-resume).
      return { state: "resume_symlink", paths };
    }
    if (legacyStat.isSymbolicLink()) {
      return symlinkTargets(legacy, renamed)
        ? { state: "already_migrated", paths }
        : { state: "conflict", paths, detail: "The legacy symlink points elsewhere" };
    }
    return {
      state: "conflict",
      paths,
      detail: `${LEGACY_DIR} and ${RENAMED_DIR} are both real directories; refusing to merge them`,
    };
  }
  if (legacyStat?.isDirectory()) return { state: "legacy_only", paths };
  if (legacyStat?.isSymbolicLink()) {
    return { state: "conflict", paths, detail: "The legacy path is a dangling symlink" };
  }
  return { state: "nothing", paths };
}

/** 머신 락 — mkdir 원자성 + pid. 죽은 홀더는 rename으로 원자 회수. */
function acquireMigrateLock(home) {
  const lock = join(home, LOCK_DIR);
  const claim = () => {
    mkdirSync(lock);
    writeFileSync(join(lock, "pid"), `${process.pid}\n`);
  };
  try {
    claim();
    return lock;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  let holder;
  try {
    holder = Number.parseInt(readFileSync(join(lock, "pid"), "utf8").trim(), 10);
  } catch {
    holder = undefined;
  }
  if (holder !== undefined && processAlive(holder)) {
    throw new Error(`Another migration is in progress (pid=${holder})`);
  }
  const reclaim = `${lock}.reclaim.${process.pid}`;
  renameSync(lock, reclaim);
  const again = (() => {
    try {
      return Number.parseInt(readFileSync(join(reclaim, "pid"), "utf8").trim(), 10);
    } catch {
      return undefined;
    }
  })();
  if (again !== undefined && again !== holder && processAlive(again)) {
    renameSync(reclaim, lock); // 그 사이 새 홀더가 생겼다 — 돌려놓는다
    throw new Error(`Another migration is in progress (pid=${again})`);
  }
  try {
    unlinkSync(join(reclaim, "pid"));
  } catch {
    // 이미 없음
  }
  rmdirSync(reclaim);
  claim();
  return lock;
}

function releaseMigrateLock(lock) {
  try {
    unlinkSync(join(lock, "pid"));
    rmdirSync(lock);
  } catch {
    // 릴리스 실패는 다음 실행의 죽은-홀더 회수가 처리한다
  }
}

function writeJournal(paths, record) {
  writeFileSync(
    paths.journal,
    `${JSON.stringify({ schema: JOURNAL_SCHEMA, ...record })}\n`,
  );
}

function verifyMigrated(paths, inventory) {
  const linkStat = lstatSync(paths.legacy);
  if (!linkStat.isSymbolicLink() || !symlinkTargets(paths.legacy, paths.renamed)) {
    throw new Error("Verification failed: the legacy symlink does not point to the new root");
  }
  const after = new Set(readdirSync(paths.renamed));
  for (const entry of inventory) {
    if (!after.has(entry)) {
      throw new Error(`Verification failed: ${entry} is missing after the move`);
    }
  }
  // 옛 절대경로 호환 — symlink를 **통해** 같은 내용이 보여야 한다.
  const throughLink = new Set(readdirSync(paths.legacy));
  for (const entry of inventory) {
    if (!throughLink.has(entry)) {
      throw new Error(`Verification failed: ${entry} is not accessible through the legacy symlink`);
    }
  }
}

/**
 * 실행. preview(기본)는 계획·차단자만 보고하고 아무것도 바꾸지 않는다.
 * 반환: { state, applied, blockers, log: string[] }
 */
export function migrateHome(home, { apply = false } = {}) {
  const log = [];
  const inspection = inspectMigrateHome(home);
  const { paths } = inspection;

  if (inspection.state === "nothing") {
    log.push("Nothing to move: neither directory exists.");
    return { ...inspection, applied: false, blockers: [], log };
  }
  if (inspection.state === "already_migrated") {
    log.push(`Already migrated: ${paths.renamed} (with a compatibility symlink).`);
    return { ...inspection, applied: false, blockers: [], log };
  }
  if (inspection.state === "conflict") {
    throw new Error(`Migration blocked: ${inspection.detail}`);
  }

  if (inspection.state === "resume_symlink") {
    // 저널이 이동 완료를 증언해야만 이어간다 — 저널 없이 .dure만 있는 머신을
    // 함부로 "우리가 옮기다 만 것"으로 단정하면 안 된다.
    const journal = readJson(paths.journal);
    if (journal?.schema !== JOURNAL_SCHEMA || journal.step !== "moved") {
      throw new Error(
        `Migration blocked: only ${paths.renamed} exists, without journal evidence. Manual review is required`,
      );
    }
    log.push("The previous run stopped after the rename. Completing the compatibility symlink.");
    if (!apply) {
      log.push("(preview; use --apply to execute)");
      return { ...inspection, applied: false, blockers: [], log };
    }
    symlinkSync(RENAMED_DIR, paths.legacy);
    verifyMigrated(paths, journal.inventory ?? []);
    writeJournal(paths, { step: "done", finishedAt: new Date().toISOString() });
    log.push(`Completed: ${paths.legacy} → ${paths.renamed} symlink.`);
    return { ...inspection, applied: true, blockers: [], log };
  }

  // legacy_only — 본 이동.
  const blockers = collectQuiesceBlockers(home);
  const inventory = readdirSync(paths.legacy);
  log.push(`Plan: mv ${paths.legacy} → ${paths.renamed}, then create a compatibility symlink.`);
  log.push(`Top-level entries to move: ${inventory.length}.`);
  if (blockers.length > 0) {
    log.push("Blockers:");
    for (const blocker of blockers) log.push(`  - ${blocker}`);
  }
  if (!apply) {
    log.push("(preview; use --apply to execute)");
    return { ...inspection, applied: false, blockers, log };
  }
  if (blockers.length > 0) {
    throw new Error(
      `Migration blocked: ${blockers.length} active users. Stop them first\n${blockers.join("\n")}`,
    );
  }

  const lock = acquireMigrateLock(home);
  try {
    // 락을 쥔 뒤 재검증 — quiesce와 락 획득 사이의 창을 닫는다.
    const recheck = collectQuiesceBlockers(home);
    if (recheck.length > 0) {
      throw new Error(`Migration blocked: an active user appeared while acquiring the lock\n${recheck.join("\n")}`);
    }
    writeJournal(paths, { step: "planned", inventory, startedAt: new Date().toISOString() });
    renameSync(paths.legacy, paths.renamed);
    writeJournal(paths, { step: "moved", inventory, movedAt: new Date().toISOString() });
    symlinkSync(RENAMED_DIR, paths.legacy);
    try {
      verifyMigrated(paths, inventory);
    } catch (error) {
      // 롤백 — rename은 데이터를 복사하지 않으므로 역방향 rename 한 번이다.
      try {
        unlinkSync(paths.legacy);
      } catch {
        // symlink가 없으면 그대로 진행
      }
      renameSync(paths.renamed, paths.legacy);
      writeJournal(paths, { step: "rolled_back", reason: String(error) });
      throw error;
    }
    writeJournal(paths, { step: "done", inventory, finishedAt: new Date().toISOString() });
    log.push(`Completed: ${paths.renamed} + compatibility symlink ${paths.legacy}.`);
    log.push("Legacy absolute paths and unchanged scripts continue to work through the symlink.");
    return { ...inspection, applied: true, blockers: [], log };
  } finally {
    releaseMigrateLock(lock);
  }
}
