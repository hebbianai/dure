/**
 * 빌드 산출물 회수(GC) 판정 — 순수 모듈.
 *
 * 배경(2026-07-30 사고): 이 저장소는 링크 워크트리 ~100개를 동시에 둔다. 각
 * 워크트리는 cargo 워크스페이스마다 자기 `target/`을 갖고(`hmux/`, `src-tauri/`,
 * `crates/*`, `mobile/src-tauri/`), 하나가 10~50GiB까지
 * 자란다. 아무도 지우지 않으므로 총량은 단조 증가한다. 1.8TiB 디스크가
 * 386MiB만 남은 상태에서 발견됐고, 증상은 "빌드가 20분 돌다가
 * `No space left on device`로 죽는다"였다 — 게이트·CI·dev 앱 전부.
 *
 * 나쁜 실패 양식이 두 가지다:
 *  1. **늦게** 실패한다. 남은 공간은 빌드 *시작 전에* 알 수 있는데도, cargo는
 *     링크 단계에서야 죽는다. 그때까지의 CPU와 대기 시간이 전부 버려진다.
 *  2. **남을 오염시킨다**. 한 워크트리가 디스크를 채우면 다른 에이전트의
 *     게이트도 같이 죽는다. 원인 워크트리는 로그에 나타나지 않는다.
 *
 * 그래서 판정을 여기 순수 함수로 모았다 — 무엇을 지워도 되는지(eligibility),
 * 얼마나 지워야 하는지(reclaimNeed), 어느 것부터 지울지(planReclaim), 그리고
 * 지우기 직전 경로가 정말 빌드 산출물인지(isBuildOutputPath). fs·git·프로세스
 * 조회 없이 테스트된다.
 *
 * 지워도 되는 근거: `target/`은 AGENTS.md의 "Do not touch / generated" 목록에
 * 있다 — 커밋되지 않고 손으로 편집되지 않는 생성물이다. 손실은 재빌드 시간뿐,
 * 되돌릴 수 없는 상태는 없다.
 */

export const GIB = 1024 ** 3;

/** Refuse to start a build below this much free space.
 *
 *  The rationale is unchanged from 2026-07-30: one `pnpm verify:release` fills
 *  hmux/target and src-tauri/target together, measured at 25-50GiB combined, so
 *  the floor leaves room for one more worst-case full build after the admitted
 *  one. Only the number moved. It was 100GiB, sized for the 1.8TiB host this
 *  guard was written on; this volume is 926GB, where 100GiB plus a build budget
 *  exceeded the free space the machine ever has and refused every deploy
 *  (2026-09-01). 60GiB still covers a worst-case full build with margin.
 *
 *  Raise it again on a larger volume — do not lower it further without a
 *  measurement, or concurrent builds return to dying at the link step. */
export const DEFAULT_FLOOR_BYTES = 60 * GIB;

/** GC가 목표로 삼는 여유 공간. floor보다 넉넉하게 잡는다 — floor에 딱 맞춰
 *  회수하면 다음 빌드가 다시 floor를 깨고, 매 빌드마다 GC가 돈다.
 *  Kept at twice the floor: reclaim buys headroom for a second build, it does
 *  not vacuum every landed worktree on the host. */
export const DEFAULT_GOAL_BYTES = 120 * GIB;

/** Aggregate generated `target/` budget across local linked worktrees. This is
 * intentionally generous enough for several warm Rust workspaces while still
 * bounding monotonic growth on the 1.8TiB shared development host. Smaller
 * volumes remain protected by the independent free-space floor. */
export const DEFAULT_LOCAL_CACHE_BUDGET_BYTES = 600 * GIB;

/** Worst-case growth admitted for one cooperating build. The reservation is
 * deliberately coarse: a caller selects an execution class, while the shared
 * admission authority owns all arithmetic. Adding per-command guesses at call
 * sites would recreate the overbooking bug with several competing truths.
 *
 * `dev` was 50GiB, which no measurement supported: a fully warm dev worktree
 * here holds 13.2GiB in src-tauri/target, and a `dev` build only grows that one
 * workspace. Combined with the floor it made `pnpm app:dev:deploy` demand more
 * free space than this volume has, so the daily driver could never relaunch
 * (2026-09-01). 20GiB is ~1.5x the measured warm footprint. The release-class
 * budgets stay where they are: they cover several workspaces at once and have
 * not been measured down.
 *
 * `cli` was named `rust` and sized 40GiB, as if it gated a whole Rust
 * workspace. Its only caller is the Dure CLI control-plane build, which builds
 * one package out of crates/dure-app; that workspace's target measures 648MB
 * after a cold release build and 835MB in a long-lived worktree. Asking 40GiB
 * for it put the dev-launch prerequisite chain over this volume and failed
 * every deploy even after the `dev` budget was fixed (2026-09-01). 4GiB is ~5x
 * the larger measurement. The name moved with the number: a future
 * whole-workspace Rust gate must add its own class rather than inherit a
 * single-package budget, and `buildStorageBudget` fails closed on the old name
 * instead of silently under-booking. */
export const BUILD_STORAGE_BUDGETS = Object.freeze({
  frontend: 10 * GIB,
  cli: 4 * GIB,
  mobile: 35 * GIB,
  full: 50 * GIB,
  qa: 50 * GIB,
  dev: 20 * GIB,
});

export function buildStorageBudget(kind) {
  const budget = BUILD_STORAGE_BUDGETS[kind];
  if (!Number.isSafeInteger(budget) || budget <= 0) {
    throw new Error(`unknown build storage budget: ${String(kind)}`);
  }
  return budget;
}

/**
 * POSIX `df -k <path>` 출력에서 사용 가능한 바이트를 읽는다.
 *
 * macOS와 Linux의 컬럼 수가 다르고(macOS는 iused/ifree/%iused가 더 붙는다),
 * 장치 이름이 길면 Linux df는 데이터 행을 줄바꿈한다. 그래서 헤더에서
 * "Avail"로 시작하는 컬럼의 위치를 찾아 쓰고, 그 위치가 숫자가 아니면
 * 두 형식이 공통으로 갖는 4번째 컬럼(fs, blocks, used, avail)로 되돌린다.
 *
 * @returns {number|null} 바이트. 파싱 실패면 null (호출자는 게이트를 막지 않는다)
 */
export function parseDfAvailableBytes(stdout) {
  const lines = String(stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return null;

  const header = lines[0].split(/\s+/);
  const availIndex = header.findIndex((column) => /^avail/i.test(column));

  // 장치 이름이 길어 데이터 행이 줄바꿈된 경우: 숫자만 있는 다음 행과 이어 붙인다.
  const rows = lines.slice(1);
  const joined = [];
  for (const row of rows) {
    const fields = row.split(/\s+/);
    if (joined.length > 0 && fields.length > 0 && /^\d/.test(fields[0]) === false) {
      joined.push(fields);
      continue;
    }
    if (fields.length < 4 && joined.length > 0) {
      joined[joined.length - 1] = joined[joined.length - 1].concat(fields);
      continue;
    }
    joined.push(fields);
  }
  const data = joined[0] ?? [];
  const wrapped = data.length < 4 && joined.length > 1 ? data.concat(joined[1]) : data;

  const candidates = [availIndex, 3, wrapped.length >= 4 ? wrapped.length - 3 : -1];
  for (const index of candidates) {
    if (index < 0 || index >= wrapped.length) continue;
    const raw = wrapped[index];
    if (!/^\d+$/.test(raw)) continue;
    return Number(raw) * 1024;
  }
  return null;
}

/**
 * 얼마나 회수해야 하는지.
 *
 * @param {{availBytes: number|null, floorBytes?: number, goalBytes?: number}} input
 * @returns {{belowFloor: boolean, needBytes: number, unknown: boolean}}
 */
export function reclaimNeed({
  availBytes,
  floorBytes = DEFAULT_FLOOR_BYTES,
  goalBytes = DEFAULT_GOAL_BYTES,
}) {
  // 공간을 못 읽었으면 아무 주장도 하지 않는다 — 측정 실패로 빌드를 막으면
  // 디스크가 멀쩡한 머신에서 게이트가 통째로 멈춘다(fail-open).
  if (typeof availBytes !== "number" || !Number.isFinite(availBytes)) {
    return { belowFloor: false, needBytes: 0, unknown: true };
  }
  const goal = Math.max(goalBytes, floorBytes);
  return {
    belowFloor: availBytes < floorBytes,
    needBytes: Math.max(0, goal - availBytes),
    unknown: false,
  };
}

export function storageReclaimNeed({
  availBytes,
  totalCacheBytes,
  floorBytes = DEFAULT_FLOOR_BYTES,
  goalBytes = DEFAULT_GOAL_BYTES,
  cacheBudgetBytes = DEFAULT_LOCAL_CACHE_BUDGET_BYTES,
}) {
  const freeSpace = reclaimNeed({ availBytes, floorBytes, goalBytes });
  const cacheExcessBytes = Number.isFinite(totalCacheBytes)
    ? Math.max(0, totalCacheBytes - cacheBudgetBytes)
    : 0;
  return {
    ...freeSpace,
    cacheExcessBytes,
    freeSpaceNeedBytes: freeSpace.needBytes,
    needBytes: Math.max(freeSpace.needBytes, cacheExcessBytes),
    overCacheBudget: cacheExcessBytes > 0,
  };
}

/**
 * 한 워크트리의 빌드 산출물을 지워도 되는지 — 순수 판정.
 *
 * 두 단계(tier)를 둔다:
 *  - `safe`: 랜딩 완료 + clean + 그 워크트리를 cwd로 잡은 프로세스 없음.
 *    아무의 작업도 방해하지 않는다 — 자동 GC는 이것만 쓴다.
 *  - `aggressive`: an operator may override only Git-state heuristics
 *    (unlanded or dirty) for an otherwise idle worktree.
 *
 * Neither tier ever overrides a Dure session reference, live activity, an
 * active build, the caller's worktree, or explicit protection. Process-CWD
 * absence is authority only for disposable build outputs; it must never
 * authorize removing the worktree.
 */
export function buildOutputEligibility({
  isCurrentWorktree = false,
  isProtected = false,
  isSessionReferenced = false,
  hasLiveBuild = false,
  landed = false,
  dirty = false,
  hasLiveProcess = false,
  aggressive = false,
}) {
  if (hasLiveBuild) return { eligible: false, reason: "building" };
  if (isCurrentWorktree) return { eligible: false, reason: "current-worktree" };
  if (isProtected) return { eligible: false, reason: "protected" };
  if (isSessionReferenced) {
    return { eligible: false, reason: "session-referenced" };
  }
  if (hasLiveProcess) return { eligible: false, reason: "live-process" };
  if (landed && !dirty) {
    return { eligible: true, reason: "landed-clean-idle", tier: "safe" };
  }
  if (!aggressive) {
    if (!landed) return { eligible: false, reason: "unlanded" };
    if (dirty) return { eligible: false, reason: "dirty" };
    return { eligible: false, reason: "live-process" };
  }
  return { eligible: true, reason: "aggressive", tier: "aggressive" };
}

/**
 * Continue a transaction that already isolated one exact generated output.
 * Git and age heuristics cannot revoke that durable claim; session references,
 * processes, the current worktree, and explicit protection remain authoritative
 * until deletion.
 */
export function isolatedBuildOutputEligibility({
  isCurrentWorktree = false,
  isProtected = false,
  isSessionReferenced = false,
  hasLiveBuild = false,
  hasLiveProcess = false,
}) {
  if (hasLiveBuild) return { eligible: false, reason: "building" };
  if (isCurrentWorktree) return { eligible: false, reason: "current-worktree" };
  if (isProtected) return { eligible: false, reason: "protected" };
  if (isSessionReferenced) {
    return { eligible: false, reason: "session-referenced" };
  }
  if (hasLiveProcess) return { eligible: false, reason: "live-process" };
  return {
    eligible: true,
    reason: "isolated-transaction",
    tier: "recovery",
  };
}

/**
 * 필요량을 채울 만큼만 고른다 — 큰 것부터.
 *
 * 필요량만큼만 지우는 이유: 디스크를 비우는 값은 남의 재빌드 시간이다. 목표를
 * 넘겨 더 지우면 그만큼을 공짜로 태운다. `needBytes`가 null/Infinity면 전량.
 *
 * @param {{path: string, bytes: number}[]} candidates
 * @param {number|null} needBytes
 */
export function planReclaim(candidates, needBytes) {
  const all = needBytes === null || needBytes === Infinity;
  // 같은 크기끼리는 경로 순 — 같은 입력이 같은 계획을 내야 진단이 재현된다.
  const ordered = [...candidates].sort(
    (a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path),
  );
  const selected = [];
  let freedBytes = 0;
  for (const candidate of ordered) {
    if (!all && freedBytes >= needBytes) break;
    selected.push(candidate);
    freedBytes += candidate.bytes;
  }
  return {
    selected,
    freedBytes,
    satisfied: all ? true : freedBytes >= (needBytes ?? 0),
  };
}

/**
 * 지우기 직전 마지막 방어선.
 *
 * 경로 조작이나 계산 실수로 워크트리 루트나 소스 디렉터리가 넘어오는 경우를
 * 막는다. 통과 조건: 저장소 루트 아래이고, 마지막 요소가 정확히 `target`이며,
 * 다른 `target/` 안에 중첩되지 않았고, `..`가 없다.
 */
export function isBuildOutputPath(repoRoot, path) {
  if (typeof repoRoot !== "string" || typeof path !== "string") return false;
  if (!repoRoot || !path) return false;
  const root = repoRoot.replace(/\/+$/, "");
  if (!path.startsWith(`${root}/`)) return false;
  const relative = path.slice(root.length + 1);
  const segments = relative.split("/");
  if (segments.includes("..") || segments.includes("")) return false;
  if (segments[segments.length - 1] !== "target") return false;
  // 중첩 target (예: hmux/target/debug/target) 은 상위 하나만 지우면 되고,
  // 이런 경로가 넘어왔다는 것 자체가 탐색이 잘못됐다는 신호다.
  if (segments.slice(0, -1).includes("target")) return false;
  return true;
}

/** 사람이 읽는 크기. 로그에만 쓴다. */
export function formatBytes(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "?";
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(1)} GiB`;
  return `${Math.round(bytes / (1024 * 1024))} MiB`;
}
