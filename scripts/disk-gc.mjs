#!/usr/bin/env node
/**
 * 빌드 산출물 회수 CLI.
 *
 *   pnpm disk:status                     남은 공간과 회수 가능량만 본다
 *   pnpm disk:gc                         계획만 출력 (기본은 dry-run)
 *   pnpm disk:gc --apply                 안전 단계만 회수 (랜딩·clean·유휴)
 *   pnpm disk:gc --apply --all           목표치가 아니라 전량 회수
 *   pnpm disk:gc --apply --aggressive    유휴한 미랜딩·dirty 워크트리까지 (사람 판단)
 *   pnpm disk:gc --worktree /abs/path    정확히 한 등록 워크트리만 계획
 *   pnpm disk:gc --json                  자동화용
 *
 * 기본이 dry-run인 이유: 파괴적 도구의 기본값은 아무것도 지우지 않는 것이어야
 * 한다. 자동 경로(빌드 전 관문)는 `ensureHeadroom`이 명시적으로 apply를 켠다.
 */

import { fileURLToPath } from "node:url";
import { enterBackgroundCpuPriority } from "./lib/background-cpu-priority.mjs";
import { inspectBuildStorageReservations } from "./lib/build-storage-reservation.mjs";
import { reclaimCargoCaches } from "./lib/cargo-cache-reclaim.mjs";
import {
  DiskGcScopeError,
  parseWorktreeScope,
} from "./lib/disk-gc-scope.mjs";
import { formatBytes, reclaim } from "./lib/disk-reclaim.mjs";
import { GIB } from "./lib/disk-space.mjs";

export const DISK_GC_HELP = `Usage: pnpm disk:gc [options]

Build-output reclamation is a dry-run unless --apply is present.
It only removes generated target directories and never removes Git worktrees.
Aggressive mode overrides Git-state heuristics; it does not override live activity
or Dure session references.

Options:
  --worktree <absolute path>  Limit discovery, planning, and apply to one exact
                              registered Git worktree
  --apply                     Apply the selected plan
  --all                       Select every eligible target in scope
  --aggressive                Include idle unlanded or dirty worktrees in scope
  --cache-only                Reclaim only compiler caches under Cargo locks;
                              requires --worktree, preserves open panes and runtimes
                              may discard unpacked macOS Rust debug objects
  --floor=<GiB>               Override the free-space floor
  --goal=<GiB>                Override the free-space goal
  --json                      Emit a machine-readable report
  --status                    Show status only
  --help                      Show this help`;

function numberFlag(arguments_, name, fallback) {
  const flag = arguments_.find((argument) =>
    argument.startsWith(`--${name}=`),
  );
  if (!flag) return fallback;
  const value = Number(flag.slice(`--${name}=`.length));
  return Number.isFinite(value) && value > 0 ? value * GIB : fallback;
}

function publicEntry({ path, bytes, tier, kind, lifecycle }) {
  return { path, bytes, tier, kind, ...(lifecycle ? { lifecycle } : {}) };
}

function publicRemoval(entry) {
  return { ...publicEntry(entry), worktree: entry.worktree };
}

function publicOutcome({ path, phase, reason, worktree, kind }) {
  return {
    ...(path ? { path } : {}),
    ...(phase ? { phase } : {}),
    reason,
    ...(worktree ? { worktree } : {}),
    ...(kind ? { kind } : {}),
  };
}

export function publicDiskGcReport(report, reservations = null) {
  return {
    ...report,
    ...(reservations ? { reservations } : {}),
    plan: {
      ...report.plan,
      selected: report.plan.selected.map(publicEntry),
    },
    removed: report.removed.map(publicRemoval),
    refused: report.refused.map(publicOutcome),
    skipped: report.skipped.map(publicOutcome),
  };
}

function publicReservations(report) {
  if (!report) return null;
  return {
    reservedBytes: report.reservedBytes,
    invalidCount: report.invalid.length,
    observationStatus: report.observationStatus,
    active: report.active.map(({ record, liveness }) => ({
      acquiredAtUnixMs: record.acquiredAtUnixMs,
      cwd: record.cwd,
      label: record.label,
      liveness,
      pid: record.pid,
      requestedBytes: record.requestedBytes,
    })),
  };
}

export function diskGcExitCode(report) {
  return report.applied &&
    (!report.satisfied || report.refused.length > 0)
    ? 1
    : 0;
}

function publicScopeError(error) {
  return {
    applied: false,
    error: { code: error.code, message: error.message },
    scope: {
      kind: "worktree",
      ...(error.path ? { requestedPath: error.path } : {}),
    },
  };
}

export function main(arguments_ = process.argv.slice(2)) {
  const json = arguments_.includes("--json");
  if (arguments_.includes("--help")) {
    console.log(DISK_GC_HELP);
    return 0;
  }

  const apply = arguments_.includes("--apply");
  const statusOnly = arguments_.includes("--status");
  let report;
  try {
    const worktree = parseWorktreeScope(arguments_);
    const reclaimSelected = arguments_.includes("--cache-only") ? reclaimCargoCaches : reclaim;
    report = reclaimSelected({
      apply: apply && !statusOnly,
      aggressive: arguments_.includes("--aggressive"),
      all: arguments_.includes("--all") || statusOnly,
      floorBytes: numberFlag(arguments_, "floor", undefined),
      goalBytes: numberFlag(arguments_, "goal", undefined),
      worktree,
    });
  } catch (error) {
    if (!(error instanceof DiskGcScopeError)) throw error;
    if (json) {
      console.log(JSON.stringify(publicScopeError(error), null, 2));
    } else {
      console.error(`disk:gc refused: ${error.message}`);
    }
    return 2;
  }
  let reservations;
  try {
    reservations = publicReservations(
      inspectBuildStorageReservations({ cwd: report.mainRoot }),
    );
  } catch (error) {
    reservations = {
      active: [],
      invalidCount: 1,
      observationStatus: "incomplete",
      reservedBytes: null,
      error: error.message,
    };
  }

  if (json) {
    console.log(JSON.stringify(publicDiskGcReport(report, reservations), null, 2));
    return diskGcExitCode(report);
  }

  const reasons = new Map();
  for (const entry of report.skipped) {
    reasons.set(entry.reason, (reasons.get(entry.reason) ?? 0) + 1);
  }

  const scopeLabel =
    report.scope.kind === "worktree"
      ? report.scope.path
      : "등록된 전체 워크트리";
  console.log(`범위               ${scopeLabel}`);
  console.log(`저장소            ${report.mainRoot}`);
  console.log(
    `여유 공간         ${formatBytes(report.availableBefore)}` +
      (report.unknownSpace ? " (측정 실패 — 판단 보류)" : "") +
      `  하한 ${formatBytes(report.floorBytes)} / 목표 ${formatBytes(report.goalBytes)}`,
  );
  console.log(
    report.mode === "cache-only"
      ? `Compiler caches    ${formatBytes(report.totalCacheBytes)} (incremental, Rust archives, macOS debug objects)`
      : `로컬 build cache ${formatBytes(report.totalCacheBytes)} / ${formatBytes(report.cacheBudgetBytes)}`,
  );
  console.log(
    `회수 가능         ${report.candidateCount}개 target, ` +
      `${formatBytes(report.plan.selected.reduce((sum, entry) => sum + entry.bytes, 0))}`,
  );
  console.log(
    `빌드 예약         ${reservations.active.length}개, ${formatBytes(reservations.reservedBytes)}` +
      (reservations.invalidCount > 0
        ? ` (invalid ${reservations.invalidCount})`
        : ""),
  );
  if (reasons.size > 0) {
    console.log(
      `건너뜀            ${[...reasons]
        .map(([reason, count]) => `${reason} ${count}`)
        .join(", ")}`,
    );
  }

  if (statusOnly) {
    for (const entry of report.plan.selected.slice(0, 10)) {
      console.log(`  ${formatBytes(entry.bytes).padStart(10)}  ${entry.path}`);
    }
    return 0;
  }

  if (!report.applied) {
    console.log("");
    for (const entry of report.plan.selected) {
      console.log(`  회수 예정  ${formatBytes(entry.bytes).padStart(10)}  ${entry.path}`);
    }
    console.log(
      report.plan.selected.length === 0
        ? "\n회수할 것이 없습니다."
        : `\n지우려면 --apply 를 붙이세요. (${formatBytes(report.plan.freedBytes)} 회수 예정)`,
    );
    return 0;
  }

  console.log("");
  console.log(
    `회수 완료         ${report.removed.length}개, ${formatBytes(report.removedBytes)}`,
  );
  console.log(`여유 공간         ${formatBytes(report.availableAfter)}`);
  if (report.refused.length > 0) {
    console.error(`거부/실패         ${report.refused.length}건`);
    for (const entry of report.refused) {
      console.error(`  ${entry.path}: ${entry.detail ?? entry.reason}`);
    }
  }
  if (!report.satisfied) console.error("회수 미완료         선택된 작업이 남았습니다.");
  return diskGcExitCode(report);
}

export function runDiskGcCli(
  arguments_,
  { enterBackground = enterBackgroundCpuPriority, execute = main } = {},
) {
  enterBackground();
  return execute(arguments_);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = runDiskGcCli(process.argv.slice(2));
}
