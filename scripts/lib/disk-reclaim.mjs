/**
 * 빌드 산출물 회수 실행부 — git·프로세스·fs를 실제로 만지는 층.
 *
 * 판정은 전부 `disk-space.mjs`(순수)에 있다. 여기서는 그 판정에 필요한 사실을
 * 모으고, 결정된 것을 지운다. 왜 이 분리인가: "지워도 되는가"는 규칙이라
 * 픽스처 없이 테스트해야 하고, "무엇이 랜딩됐나"는 관측이라 테스트할 게 아니다.
 *
 * 사고 배경과 층 설계 근거는 disk-space.mjs 헤더에 있다.
 */

import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  realpathSync,
  statfsSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { readVerifiedDescriptorText } from "../../cli/lib/fd-verified-read.mjs";
import {
  directoryGeneration,
  directoryGenerationAuthority,
  directoryIdentity,
} from "./atomic-directory-move.mjs";
import { backgroundCpuPriorityCommand } from "./background-cpu-priority.mjs";
import { appRoot } from "./dure-home.mjs";
import { withoutLocalGitOverrides } from "./git-environment.mjs";
import {
  buildOutputEligibility,
  DEFAULT_FLOOR_BYTES,
  DEFAULT_GOAL_BYTES,
  DEFAULT_LOCAL_CACHE_BUDGET_BYTES,
  formatBytes,
  isBuildOutputPath,
  isolatedBuildOutputEligibility,
  parseDfAvailableBytes,
  planReclaim,
  storageReclaimNeed,
} from "./disk-space.mjs";
import { selectRegisteredWorktrees } from "./disk-gc-scope.mjs";
import {
  observeWorktreeProcesses,
  readGitWorktreeInventory,
  worktreeProcessReason,
} from "./worktree-inventory.mjs";

/** cargo target은 워크스페이스 루트마다 생긴다. 새 크레이트가 늘어도 탐색으로
 *  따라가야 하므로 목록을 박지 않고 깊이 제한 탐색을 쓴다 — 대신 무한히 파고
 *  들지 않게 깊이를 5로 묶는다(`crates/<name>/target`, `mobile/src-tauri/target`
 *  까지 닿는 깊이). */
const MAX_TARGET_DEPTH = 5;
const MAX_SESSION_REGISTRY_BYTES = 512 * 1024;
const MAX_SESSION_REGISTRIES = 256;
const MAX_SESSION_REFERENCES = 512;
const MAX_SESSION_PATH_BYTES = 4_096;
const APP_CHANNEL_NAME = /^[a-z0-9-]{1,64}$/;
const SKIP_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  ".worktrees",
  ".claude-worktrees",
  ".dure-reclaim",
]);

function git(arguments_, cwd) {
  return execFileSync("git", arguments_, {
    cwd,
    encoding: "utf8",
    env: withoutLocalGitOverrides(process.env),
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function gitOk(arguments_, cwd) {
  try {
    git(arguments_, cwd);
    return true;
  } catch {
    return false;
  }
}

/** 이 프로세스가 속한 워크트리와, 워크트리들이 매달린 저장소 루트. */
export function repositoryRoots(cwd = process.cwd()) {
  const currentWorktree = git(["rev-parse", "--show-toplevel"], cwd);
  // 링크 워크트리에서는 공용 git 디렉터리가 메인 체크아웃 안에 있다.
  const commonDirectory = git(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    cwd,
  );
  return { currentWorktree, mainRoot: dirname(commonDirectory) };
}

/** `git worktree list`가 권위다 — `.worktrees/` 글로브는 등록되지 않은
 *  잔여 디렉터리까지 집어 온다. */
export function listWorktrees(cwd) {
  return readGitWorktreeInventory(cwd).map((entry) => entry.path);
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizedSessionPath(path) {
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    Buffer.byteLength(path, "utf8") > MAX_SESSION_PATH_BYTES ||
    /[\u0000-\u001f\u007f]/.test(path)
  ) {
    return null;
  }
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch (error) {
    return error?.code === "ENOENT" ? absolute : null;
  }
}

function readSessionRegistry(path) {
  let descriptor;
  try {
    descriptor = openSync(path, "r");
    const before = fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      before.size < 1n ||
      before.size > BigInt(MAX_SESSION_REGISTRY_BYTES)
    ) {
      return { state: "invalid", worktrees: [] };
    }
    const text = readVerifiedDescriptorText(descriptor, before);
    if (text === null) return { state: "changed", worktrees: [] };
    const value = JSON.parse(text);
    if (
      !record(value) ||
      !Array.isArray(value.agents) ||
      value.agents.length > MAX_SESSION_REFERENCES
    ) {
      return { state: "invalid", worktrees: [] };
    }
    const worktrees = [];
    for (const agent of value.agents) {
      const worktree = record(agent)
        ? normalizedSessionPath(agent.worktree)
        : null;
      if (worktree === null) return { state: "invalid", worktrees: [] };
      worktrees.push(worktree);
    }
    return { state: "available", worktrees };
  } catch (error) {
    return {
      state: error?.code === "ENOENT" ? "absent" : "invalid",
      worktrees: [],
    };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function sessionRegistryPaths(root) {
  const paths = [join(root, "agents.json")];
  const channels = join(root, "channels");
  let entries;
  try {
    entries = readdirSync(channels, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return paths;
    throw error;
  }
  const channelEntries = entries
    .filter((entry) => APP_CHANNEL_NAME.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (channelEntries.length > MAX_SESSION_REGISTRIES - 1) {
    throw new Error("Dure session registry census exceeded its item limit");
  }
  for (const entry of channelEntries) {
    if (!entry.isDirectory()) {
      throw new Error("Dure app channel is not a directory");
    }
    paths.push(join(channels, entry.name, "agents.json"));
  }
  return paths;
}

function readSessionRegistryCensus(root) {
  let paths;
  try {
    paths = sessionRegistryPaths(root);
  } catch {
    return { status: "incomplete", reason: "session-registry-census-unavailable" };
  }
  const referenceCounts = new Map();
  const states = [];
  for (const path of paths) {
    const registry = readSessionRegistry(path);
    states.push(registry.state);
    if (registry.state === "invalid") {
      return { status: "incomplete", reason: "session-registry-invalid" };
    }
    if (registry.state === "changed") {
      return { status: "incomplete", reason: "session-registry-changed" };
    }
    for (const worktree of registry.worktrees) {
      referenceCounts.set(worktree, (referenceCounts.get(worktree) ?? 0) + 1);
    }
  }
  const references = [...referenceCounts]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, count]) => ({ path, count }));
  return {
    status: "complete",
    signature: JSON.stringify({ paths, references, states }),
    references,
  };
}

/**
 * Observe the stable and channel-scoped Dure client projections. These paths
 * are protective references, not runtime liveness claims: a stale projection
 * may conservatively retain generated output, while an unreadable or changing
 * census must never become evidence that a worktree is idle.
 */
export function observeDureSessionWorktrees(
  worktrees,
  {
    selectedWorktrees = worktrees,
    root = appRoot(),
    readCensus = readSessionRegistryCensus,
  } = {},
) {
  if (typeof root !== "string" || !isAbsolute(root)) {
    return { status: "incomplete", reason: "session-registry-root-invalid" };
  }
  const registered = [
    ...new Set(worktrees.map((path) => normalizedSessionPath(path))),
  ];
  const selected = [
    ...new Set(selectedWorktrees.map((path) => normalizedSessionPath(path))),
  ];
  const registeredSet = new Set(registered);
  if (
    registered.length === 0 ||
    registered.includes(null) ||
    selected.length === 0 ||
    selected.includes(null) ||
    selected.some((path) => !registeredSet.has(path))
  ) {
    throw new Error("session scope must contain registered worktrees");
  }

  let previous = null;
  for (let sample = 0; sample < 3; sample += 1) {
    const census = readCensus(root);
    if (census?.status !== "complete") {
      return {
        status: "incomplete",
        reason:
          typeof census?.reason === "string"
            ? census.reason
            : "session-registry-census-unavailable",
      };
    }
    if (census.signature === previous?.signature) {
      const counts = new Map(
        census.references.map(({ path, count }) => [path, count]),
      );
      return {
        status: "complete",
        scope: selected,
        worktrees: selected.map((path) => ({
          path,
          referenceCount: counts.get(path) ?? 0,
        })),
      };
    }
    previous = census;
  }
  return { status: "incomplete", reason: "session-registry-census-changed" };
}

export function worktreeSessionReason(observation, worktree) {
  if (observation?.status !== "complete") {
    return "session-observation-incomplete";
  }
  const path = normalizedSessionPath(worktree);
  if (
    path === null ||
    !Array.isArray(observation.scope) ||
    !observation.scope.includes(path)
  ) {
    return "session-observation-incomplete";
  }
  const record = observation.worktrees.find((entry) => entry.path === path);
  if (
    !record ||
    !Number.isSafeInteger(record.referenceCount) ||
    record.referenceCount < 0
  ) {
    return "session-observation-incomplete";
  }
  return record.referenceCount > 0 ? "session-referenced" : null;
}

/** 워크트리 안의 cargo target 디렉터리들. 중첩 target은 위쪽 하나만 낸다. */
export function discoverBuildOutputs(worktree, depth = MAX_TARGET_DEPTH) {
  const found = [];
  const walk = (directory, remaining) => {
    if (remaining < 0) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.name === "target") {
        found.push(path);
        continue; // 그 아래로는 내려가지 않는다
      }
      walk(path, remaining - 1);
    }
  };
  walk(worktree, depth);
  return found;
}

/** `du -sk`를 한 번에 — 디렉터리마다 spawn하면 100개 워크트리에서 그 비용이
 *  회수 시간을 넘는다. */
export function measureBytes(paths) {
  if (paths.length === 0) return [];
  let raw = "";
  try {
    const measurement = backgroundCpuPriorityCommand("du", ["-sk", ...paths]);
    raw = execFileSync(measurement.command, measurement.args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (error) {
    // `du` reports a disappearing concurrent path with a non-zero exit while
    // still returning complete measurements for every stable path. Preserve
    // that positive evidence instead of collapsing the whole cache total to 0.
    raw = typeof error?.stdout === "string" ? error.stdout : "";
  }
  const sizes = new Map();
  for (const line of raw.split("\n")) {
    const match = line.match(/^(\d+)\s+(.+)$/);
    if (match) sizes.set(match[2], Number(match[1]) * 1024);
  }
  return paths.map((path) => ({ path, bytes: sizes.get(path) ?? 0 }));
}

/** 마운트의 남은 공간. 읽지 못하면 null; admission policy가 의미를 결정한다. */
export function availableBytes(path) {
  try {
    const stats = statfsSync(path, { bigint: true });
    const available = Number(stats.bavail * stats.bsize);
    if (Number.isSafeInteger(available) && available >= 0) return available;
  } catch {}
  try {
    return parseDfAvailableBytes(
      execFileSync("df", ["-k", path], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  } catch {
    return null;
  }
}

/**
 * 회수 계획을 세운다(그리고 apply면 실행한다).
 *
 * @param {{
 *   cwd?: string, apply?: boolean, aggressive?: boolean, all?: boolean,
 *   floorBytes?: number, goalBytes?: number, cacheBudgetBytes?: number,
 *   protect?: string[], worktree?: string|null,
 *   processObserver?: typeof observeWorktreeProcesses,
 *   sessionObserver?: typeof observeDureSessionWorktrees,
 *   directoryAuthority?: typeof directoryGenerationAuthority,
 * }} options
 */
export function reclaim({
  cwd = process.cwd(),
  apply = false,
  aggressive = false,
  all = false,
  floorBytes = DEFAULT_FLOOR_BYTES,
  goalBytes = DEFAULT_GOAL_BYTES,
  cacheBudgetBytes = DEFAULT_LOCAL_CACHE_BUDGET_BYTES,
  protect = [],
  worktree = null,
  processObserver = observeWorktreeProcesses,
  sessionObserver = observeDureSessionWorktrees,
  directoryAuthority = directoryGenerationAuthority,
} = {}) {
  const { currentWorktree, mainRoot } = repositoryRoots(cwd);
  const registeredWorktrees = listWorktrees(cwd);
  const worktrees = selectRegisteredWorktrees(registeredWorktrees, worktree);
  const observeProcesses = (selectedWorktrees) =>
    processObserver(registeredWorktrees, { selectedWorktrees });
  const observeSessions = (selectedWorktrees) =>
    sessionObserver(registeredWorktrees, { selectedWorktrees });
  const processObservation = observeProcesses(worktrees);
  const sessionObservation = observeSessions(worktrees);
  const avail = availableBytes(mainRoot);

  const protectedPaths = new Set(protect);
  const policyFacts = (worktree) => ({
    aggressive,
    explicitProtection: protectedPaths.has(worktree),
    isCurrentWorktree: worktree === currentWorktree,
  });
  const sourceFacts = (worktree) => ({
    ...policyFacts(worktree),
    landed: isLanded(worktree),
    dirty: isDirty(worktree),
  });
  const dynamicEligibilityFacts = (
    worktree,
    processObservation,
    currentSessionObservation,
  ) => {
    const sessionReason = worktreeSessionReason(
      currentSessionObservation,
      worktree,
    );
    if (sessionReason === "session-observation-incomplete") {
      return { error: { eligible: false, reason: sessionReason } };
    }
    const processReason = worktreeProcessReason(processObservation, worktree);
    if (processReason === "process-observation-incomplete") {
      return { error: { eligible: false, reason: processReason } };
    }
    return {
      hasLiveBuild: processReason === "building",
      hasLiveProcess: processReason === "live-process",
      isSessionReferenced: sessionReason === "session-referenced",
      processProtection: processReason === "protected",
    };
  };
  const sourceEligibilityFor = (
    worktree,
    processObservation,
    currentSessionObservation,
    facts,
  ) => {
    const dynamic = dynamicEligibilityFacts(
      worktree,
      processObservation,
      currentSessionObservation,
    );
    if (dynamic.error) return dynamic.error;
    return buildOutputEligibility({
      ...facts,
      ...dynamic,
      isProtected: facts.explicitProtection || dynamic.processProtection,
      isSessionReferenced: dynamic.isSessionReferenced,
    });
  };
  const residueEligibilityFor = (
    worktree,
    processObservation,
    currentSessionObservation,
    facts,
  ) => {
    const dynamic = dynamicEligibilityFacts(
      worktree,
      processObservation,
      currentSessionObservation,
    );
    if (dynamic.error) return dynamic.error;
    return isolatedBuildOutputEligibility({
      hasLiveBuild: dynamic.hasLiveBuild,
      hasLiveProcess: dynamic.hasLiveProcess,
      isCurrentWorktree: facts.isCurrentWorktree,
      isProtected: facts.explicitProtection || dynamic.processProtection,
      isSessionReferenced: dynamic.isSessionReferenced,
    });
  };
  const candidates = [];
  const cachePaths = new Set();
  const skipped = [];
  for (const worktree of worktrees) {
    if (!existsSync(worktree)) continue;
    const facts = sourceFacts(worktree);
    const verdict = sourceEligibilityFor(
      worktree,
      processObservation,
      sessionObservation,
      facts,
    );
    const sourceOutputs = new Set(discoverBuildOutputs(worktree));
    for (const path of sourceOutputs) cachePaths.add(path);
    let rootGeneration;
    try {
      rootGeneration = directoryIdentity(worktree);
    } catch {
      skipped.push({ worktree, reason: "worktree-generation-unavailable" });
      continue;
    }
    const residueVerdict = residueEligibilityFor(
      worktree,
      processObservation,
      sessionObservation,
      facts,
    );
    const residues = apply
      ? directoryAuthority.recover(worktree, rootGeneration)
      : directoryAuthority.inspect(worktree, rootGeneration);
    if (apply) {
      // Recovery may restore a prepared target that did not exist during the
      // first discovery. Include that authoritative generation in both the
      // cache total and the same safe eligibility path.
      for (const path of discoverBuildOutputs(worktree)) sourceOutputs.add(path);
    }
    for (const claim of residues.claims) cachePaths.add(claim.quarantine);
    for (const conflict of residues.conflicts) {
      skipped.push({
        detail: conflict.reason,
        kind: "recovery",
        reason: "reclaim-residue-conflict",
        worktree,
      });
    }
    if (residueVerdict.eligible) {
      for (const claim of residues.claims) {
        candidates.push({
          claim,
          generation: claim.generation,
          isolated: true,
          kind: "recovery",
          lifecycle: claim.state,
          path: claim.path,
          rootGeneration,
          storagePath: claim.quarantine,
          tier: residueVerdict.tier,
          worktree,
        });
      }
    } else if (residues.claims.length > 0) {
      skipped.push({ worktree, reason: residueVerdict.reason });
    }
    if (!verdict.eligible) {
      skipped.push({ worktree, reason: verdict.reason });
      continue;
    }
    for (const path of sourceOutputs) {
      try {
        candidates.push({
          claim: null,
          generation: directoryGeneration(path),
          isolated: false,
          kind: "source",
          path,
          rootGeneration,
          storagePath: path,
          worktree,
          tier: verdict.tier,
        });
      } catch {
        skipped.push({ worktree, reason: "target-generation-unavailable" });
      }
    }
  }

  const cacheSizes = measureBytes([...cachePaths]);
  const bytesByPath = new Map(
    cacheSizes.map(({ path, bytes }) => [path, bytes]),
  );
  const totalCacheBytes = cacheSizes.reduce(
    (total, entry) => total + entry.bytes,
    0,
  );
  const need = storageReclaimNeed({
    availBytes: avail,
    cacheBudgetBytes,
    floorBytes,
    goalBytes,
    totalCacheBytes,
  });
  const measured = candidates.map((entry) => ({
    ...entry,
    bytes: bytesByPath.get(entry.storagePath) ?? 0,
  }));
  const plan = planReclaim(measured, all ? null : need.needBytes);

  const removed = [];
  const refused = [];
  const applyObservations = [];
  let latestApplySessionObservation = sessionObservation;
  let applyObservationIncomplete = false;
  if (apply) {
    const observeForApply = (entry, phase) => {
      const process = observeProcesses([entry.worktree]);
      const session = observeSessions([entry.worktree]);
      latestApplySessionObservation = session;
      applyObservationIncomplete ||=
        process.status === "incomplete" || session.status === "incomplete";
      applyObservations.push({
        path: entry.path,
        phase,
        reason: process.status === "incomplete" ? process.reason : null,
        sessionReason:
          session.status === "incomplete" ? session.reason : null,
        sessionStatus: session.status,
        status: process.status,
      });
      return { process, session };
    };
    for (const entry of plan.selected) {
      // Contain each removal inside the worktree the output was discovered in,
      // not inside the main checkout. That is the property this guard is for —
      // "this target belongs to a worktree we judged eligible" — and it is the
      // stricter of the two for .worktrees/* paths, which sit several levels
      // below the main root. Checking the main root also silently refused every
      // temp-directory worktree, so the plan could list reclaimable bytes the
      // apply step would never remove and then exit non-zero.
      if (!isBuildOutputPath(entry.worktree, entry.path)) {
        refused.push({ path: entry.path, reason: "invalid-build-output-path" });
        continue;
      }
      const observationsNow = observeForApply(entry, "pre-claim");
      const authorizationFacts = entry.isolated
        ? policyFacts(entry.worktree)
        : sourceFacts(entry.worktree);
      const verdictNow = entry.isolated
        ? residueEligibilityFor(
            entry.worktree,
            observationsNow.process,
            observationsNow.session,
            authorizationFacts,
          )
        : sourceEligibilityFor(
            entry.worktree,
            observationsNow.process,
            observationsNow.session,
            authorizationFacts,
          );
      if (!verdictNow.eligible) {
        skipped.push({
          path: entry.path,
          phase: "pre-claim",
          reason: verdictNow.reason,
          worktree: entry.worktree,
        });
        continue;
      }
      let authorizationTier = verdictNow.tier;
      let claim = entry.claim;
      if (!claim) {
        try {
          claim = directoryAuthority.claim({
            generation: entry.generation,
            path: entry.path,
            root: entry.worktree,
            rootGeneration: entry.rootGeneration,
          });
        } catch (error) {
          refused.push({
            detail: error.message,
            path: entry.path,
            reason: "claim-failed",
          });
          continue;
        }
        const observationsAfterIsolation = observeForApply(
          entry,
          "post-claim",
        );
        const verdictAfterIsolation = sourceEligibilityFor(
          entry.worktree,
          observationsAfterIsolation.process,
          observationsAfterIsolation.session,
          sourceFacts(entry.worktree),
        );
        if (!verdictAfterIsolation.eligible) {
          skipped.push({
            path: entry.path,
            phase: "post-claim",
            reason: verdictAfterIsolation.reason,
            worktree: entry.worktree,
          });
          let restored = false;
          try {
            restored = directoryAuthority.restore(claim);
          } catch (error) {
            refused.push({
              detail: `${error.message}; isolated output retained`,
              path: entry.path,
              reason: "restore-failed",
            });
            continue;
          }
          if (!restored) {
            refused.push({
              detail: "retained isolated output because a replacement exists",
              path: entry.path,
              reason: "restore-conflict",
            });
          }
          continue;
        }
        authorizationTier = verdictAfterIsolation.tier;
      }
      try {
        const retiredBytes = measureBytes([claim.quarantine])[0].bytes;
        directoryAuthority.remove(claim);
        removed.push({
          ...entry,
          bytes: retiredBytes,
          tier: authorizationTier,
        });
      } catch (error) {
        refused.push({
          detail: error.message,
          path: entry.path,
          reason: "remove-failed",
        });
      }
    }
  }

  const removedBytes = removed.reduce(
    (total, entry) => total + entry.bytes,
    0,
  );
  // An empty plan cannot retire a measured target. Reuse that snapshot instead
  // of scanning protected trees again; physical headroom is still read below.
  const totalCacheAfter = apply && plan.selected.length > 0
    ? measureBytes([...cachePaths]).reduce(
        (total, entry) => total + entry.bytes,
        0,
      )
    : totalCacheBytes;
  const plannedWorkComplete = apply
    ? all
      ? removed.length === plan.selected.length
      : removedBytes >= need.needBytes && totalCacheAfter <= cacheBudgetBytes
    : plan.satisfied;
  const scopedWorkComplete =
    worktree === null || !skipped.some((entry) => entry.worktree === worktree);
  const observationsComplete =
    processObservation.status === "complete" &&
    sessionObservation.status === "complete" &&
    !applyObservationIncomplete;
  const satisfied =
    plannedWorkComplete && scopedWorkComplete && observationsComplete;

  return {
    mainRoot,
    currentWorktree,
    scope:
      worktree === null
        ? { kind: "repository", path: mainRoot }
        : { kind: "worktree", path: worktree },
    availableBefore: avail,
    availableAfter: apply ? availableBytes(mainRoot) : avail,
    floorBytes,
    goalBytes,
    cacheBudgetBytes,
    totalCacheBytes,
    totalCacheAfter,
    cacheExcessBytes: need.cacheExcessBytes,
    overCacheBudget: need.overCacheBudget,
    belowFloor: need.belowFloor,
    needBytes: need.needBytes,
    unknownSpace: need.unknown,
    processObservation: {
      status: processObservation.status,
      reason:
        processObservation.status === "incomplete"
          ? processObservation.reason
          : null,
    },
    sessionObservation: {
      status: sessionObservation.status,
      reason:
        sessionObservation.status === "incomplete"
          ? sessionObservation.reason
          : null,
      applyStatus: latestApplySessionObservation.status,
      applyReason:
        latestApplySessionObservation.status === "incomplete"
          ? latestApplySessionObservation.reason
          : null,
    },
    candidateCount: measured.length,
    plan,
    removedBytes,
    satisfied,
    removed,
    refused,
    skipped,
    applied: apply,
    applyObservations,
  };
}

function isLanded(worktree) {
  if (!gitOk(["rev-parse", "--verify", "HEAD"], worktree)) return false;
  const head = git(["rev-parse", "HEAD"], worktree);
  return gitOk(["merge-base", "--is-ancestor", head, "origin/main"], worktree);
}

function isDirty(worktree) {
  try {
    return (
      git(
        [
          "status",
          "--porcelain",
          "--",
          ".",
          ":(exclude).dure-reclaim",
          ":(exclude).dure-reclaim/**",
        ],
        worktree,
      ).length > 0
    );
  } catch {
    // 상태를 못 읽으면 dirty로 취급한다 — 모르는 워크트리를 지우지 않는다.
    return true;
  }
}
export { formatBytes };
