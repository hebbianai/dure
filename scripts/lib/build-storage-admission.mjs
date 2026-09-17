import {
  adoptBuildStorageReservation,
  BUILD_STORAGE_RESERVATION_ENV,
  buildStorageReservationRoot,
  reserveBuildStorage,
} from "./build-storage-reservation.mjs";
import {
  availableBytes,
  reclaim,
  repositoryRoots,
} from "./disk-reclaim.mjs";
import {
  DEFAULT_FLOOR_BYTES,
  DEFAULT_GOAL_BYTES,
  formatBytes,
  reclaimNeed,
} from "./disk-space.mjs";

/** One admission boundary for build growth: adopt an inherited capability or
 * publish a host-wide reservation, run only safe reclaim when capacity is
 * insufficient, then retry once against a fresh physical observation. */
export function ensureHeadroom({
  cwd = process.cwd(),
  floorBytes = DEFAULT_FLOOR_BYTES,
  goalBytes = DEFAULT_GOAL_BYTES,
  label = "build",
  log = console.error,
  requestedBytes = 0,
  reservationRoot = buildStorageReservationRoot(),
  environment = process.env,
  observeAvailableBytes = availableBytes,
  reclaimOutputs = reclaim,
  reservationOptions = {},
  reserve = reserveBuildStorage,
} = {}) {
  let root;
  try {
    root = repositoryRoots(cwd).mainRoot;
  } catch {
    if (requestedBytes > 0) {
      return {
        ok: false,
        message: `${label} was not started — its storage volume could not be resolved.`,
        report: null,
        availableBytes: null,
        reservation: null,
      };
    }
    return {
      ok: true,
      message: null,
      report: null,
      availableBytes: null,
      reservation: null,
    };
  }

  const before = observeAvailableBytes(root);
  if (requestedBytes > 0) {
    const inherited = environment[BUILD_STORAGE_RESERVATION_ENV];
    if (inherited) {
      let reservation;
      try {
        reservation = adoptBuildStorageReservation({
          ...reservationOptions,
          capability: inherited,
          cwd: root,
          requestedBytes,
          reservationRoot,
        });
      } catch {
        reservation = null;
      }
      if (reservation) {
        return {
          ok: true,
          message: null,
          report: null,
          availableBytes: before,
          reservation,
        };
      }
    }

    let admission;
    try {
      admission = reserve({
        ...reservationOptions,
        availableBytes: before,
        cwd: root,
        floorBytes,
        label,
        requestedBytes,
        reservationRoot,
      });
    } catch (error) {
      return {
        ok: false,
        message: `${label} was not started — ${error.message}`,
        report: null,
        availableBytes: before,
        reservation: null,
      };
    }
    if (admission.ok) {
      return {
        ok: true,
        message: null,
        report: null,
        availableBytes: before,
        reservation: admission.reservation,
      };
    }
    if (admission.reason !== "insufficient_unreserved_space") {
      return {
        ok: false,
        message: [
          `${label} was not started — storage admission could not establish authoritative capacity (${admission.reason}).`,
          `physical ${formatBytes(before)}, request ${formatBytes(requestedBytes)}.`,
          "Inspect active reservations and reclaimable outputs with: pnpm disk:status",
        ].join("\n"),
        report: null,
        availableBytes: before,
        reservation: null,
      };
    }

    const existingReservedBytes = Math.max(0, admission.reservedBytes ?? 0);
    const requiredFloor = floorBytes + existingReservedBytes + requestedBytes;
    const requiredGoal = goalBytes + existingReservedBytes + requestedBytes;
    // State the requirement the reservation actually enforces. Reporting only
    // the floor next to physical free space reads as a contradiction whenever
    // physical free exceeds the floor, which is the common case: the request
    // and peer reservations are what push unreserved capacity under it.
    log(
      `${label}: needs ${formatBytes(requiredFloor)} free — ` +
        `${formatBytes(floorBytes)} floor + ${formatBytes(requestedBytes)} for this build + ` +
        `${formatBytes(existingReservedBytes)} reserved by other builds — ` +
        `but the volume has ${formatBytes(before)}. ` +
        "Reclaiming landed, clean, idle build outputs — pnpm disk:gc",
    );
    const report = reclaimOutputs({
      cwd,
      apply: true,
      floorBytes: requiredFloor,
      goalBytes: requiredGoal,
    });
    const after = report.availableAfter ?? observeAvailableBytes(root);
    let retried;
    try {
      retried = reserve({
        ...reservationOptions,
        availableBytes: after,
        cwd: root,
        floorBytes,
        label,
        requestedBytes,
        reservationRoot,
      });
    } catch (error) {
      return {
        ok: false,
        message: `${label} was not started — ${error.message}`,
        report,
        availableBytes: after,
        reservation: null,
      };
    }
    if (retried.ok) {
      log(
        `${label}: admitted after reclaiming ${report.removed.length} build outputs ` +
          `(${formatBytes(after)} physical free)`,
      );
      return {
        ok: true,
        message: null,
        report,
        availableBytes: after,
        reservation: retried.reservation,
      };
    }
    const retriedReservedBytes = Math.max(0, retried.reservedBytes ?? 0);
    return {
      ok: false,
      availableBytes: after,
      report,
      reservation: null,
      message: [
        `${label} was not started — it needs ${formatBytes(
          floorBytes + retriedReservedBytes + requestedBytes,
        )} of free space and this volume has ${formatBytes(after)}.`,
        `Requirement: ${formatBytes(floorBytes)} floor + ${formatBytes(requestedBytes)} for this build + ` +
          `${formatBytes(retriedReservedBytes)} reserved by other builds.`,
        `Safe reclaim removed ${report.removed.length} outputs (${formatBytes(report.removedBytes)}).`,
        "Starting anyway could exhaust the shared volume. Inspect: pnpm disk:status",
      ].join("\n"),
    };
  }

  const need = reclaimNeed({ availBytes: before, floorBytes, goalBytes });
  if (need.unknown || !need.belowFloor) {
    return {
      ok: true,
      message: null,
      report: null,
      availableBytes: before,
      reservation: null,
    };
  }

  log(
    `${label}: 디스크 여유가 ${formatBytes(before)} 뿐입니다 (하한 ${formatBytes(
      floorBytes,
    )}). 랜딩 완료·clean·유휴 워크트리의 빌드 산출물을 회수합니다 — pnpm disk:gc`,
  );
  const report = reclaimOutputs({ cwd, apply: true, floorBytes, goalBytes });
  const after = report.availableAfter ?? observeAvailableBytes(root);
  if (typeof after === "number" && after >= floorBytes) {
    log(
      `${label}: ${formatBytes(after)} 확보 (${report.removed.length}개 target 회수)`,
    );
    return {
      ok: true,
      message: null,
      report,
      availableBytes: after,
      reservation: null,
    };
  }
  return {
    ok: false,
    availableBytes: after,
    report,
    reservation: null,
    message: [
      `${label}을 시작하지 않았습니다 — 디스크 여유 ${formatBytes(after)} < 하한 ${formatBytes(floorBytes)}.`,
      `자동 회수로는 부족합니다(회수 ${report.removed.length}개, ${formatBytes(report.removedBytes)}).`,
      "지금 빌드하면 링크 단계에서 `No space left on device`로 죽고, 같은 머신의 다른 게이트도 함께 죽습니다.",
      "다음을 확인하세요: pnpm disk:status  /  유휴 target만 더 걷으려면 pnpm disk:gc --aggressive --apply",
      "그래도 부족하면 worktree를 제거하지 말고, 다른 데이터 범주의 영향과 승인을 먼저 확인하세요.",
    ].join("\n"),
  };
}

export function assertHeadroom(options, observe = ensureHeadroom) {
  const headroom = observe(options);
  if (!headroom.ok) throw new Error(headroom.message);
  return headroom;
}
