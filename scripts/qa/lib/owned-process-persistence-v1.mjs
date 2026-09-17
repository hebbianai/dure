import crypto from "node:crypto";

export const PROCESS_START_MARKER_V1_PREFIX = "ps-lstart-v1:";

const MACOS_EXACT_MARKER =
  /^kernel-start-v3:macos:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(\d+)$/iu;
const LINUX_EXACT_MARKER =
  /^kernel-start-v2:linux:([^:\s]+):(\d+)$/u;
const LINUX_BOOTLESS_MARKER = /^kernel-start-v1:linux:(\d+)$/u;
const LINUX_PROCESS_IDENTITY = /^linux:([^:\s]+):(\d+)$/u;

const UTC_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const UTC_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

export function isProcessStartMarkerV1(value) {
  return (
    typeof value === "string" &&
    value.startsWith(PROCESS_START_MARKER_V1_PREFIX) &&
    value.length > PROCESS_START_MARKER_V1_PREFIX.length &&
    value.length <= 256
  );
}

export function formatProcessStartMarkerV1(started) {
  if (!(started instanceof Date) || Number.isNaN(started.getTime())) {
    throw new Error("invalid process start time");
  }
  const twoDigits = (value) => String(value).padStart(2, "0");
  return `${PROCESS_START_MARKER_V1_PREFIX}${UTC_WEEKDAYS[started.getUTCDay()]} ${
    UTC_MONTHS[started.getUTCMonth()]
  } ${started.getUTCDate()} ${twoDigits(started.getUTCHours())}:${twoDigits(
    started.getUTCMinutes(),
  )}:${twoDigits(started.getUTCSeconds())} ${started.getUTCFullYear()}`;
}

export function formatProcessStartMarkerV1FromUnixSeconds(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("invalid process start time");
  }
  return formatProcessStartMarkerV1(new Date(value * 1_000));
}

export function parsePersistedKernelStartMarkerV1(value) {
  if (typeof value !== "string" || value.length > 512) return null;
  const macos = value.match(MACOS_EXACT_MARKER);
  if (macos) {
    const processIdentity =
      `kernel-start-v3:macos:${macos[1].toLowerCase()}:${macos[2]}`;
    return Object.freeze({
      kind: "exact",
      marker: processIdentity,
      processIdentity,
    });
  }
  const linux = value.match(LINUX_EXACT_MARKER);
  if (linux) {
    return Object.freeze({
      kind: "exact",
      marker: `kernel-start-v2:linux:${linux[1]}:${linux[2]}`,
      processIdentity: `linux:${linux[1]}:${linux[2]}`,
    });
  }
  const bootless = value.match(LINUX_BOOTLESS_MARKER);
  if (bootless) {
    const startTicks = BigInt(bootless[1]).toString();
    return Object.freeze({
      kind: "linux_bootless",
      marker: `kernel-start-v1:linux:${startTicks}`,
      startTicks,
    });
  }
  return null;
}

export function persistedKernelStartMarkerV1(processIdentity) {
  const persisted = parsePersistedKernelStartMarkerV1(processIdentity);
  if (persisted?.kind === "exact") return persisted.marker;
  const linux = typeof processIdentity === "string"
    ? processIdentity.match(LINUX_PROCESS_IDENTITY)
    : null;
  if (linux) {
    return `kernel-start-v2:linux:${linux[1]}:${linux[2]}`;
  }
  throw new Error("invalid process identity for v1 persistence");
}

export function persistedOwnedProcessV1(member, startMarker) {
  return Object.freeze({
    groupId: member.groupId,
    kernelStartMarker: persistedKernelStartMarkerV1(member.processIdentity),
    parentPid: member.parentPid,
    pid: member.pid,
    sessionId: member.sessionId,
    startMarker: startMarker ??
      formatProcessStartMarkerV1FromUnixSeconds(
        member.startedAtUnixSeconds,
      ),
  });
}

export function ownedProcessGenerationDigestV1(processes) {
  const canonical = [...processes]
    .map((process) =>
      [
        process.pid,
        process.startMarker,
        process.kernelStartMarker,
        process.parentPid,
        process.groupId,
        process.sessionId,
      ].join("\0"),
    )
    .sort()
    .join("\n");
  return crypto.createHash("sha256").update(canonical).digest("hex");
}
