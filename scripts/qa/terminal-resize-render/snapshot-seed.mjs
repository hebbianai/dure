import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const MAX_REPAINT_BYTES = 512 * 1024;
const MAX_DIMENSION = 1_000;

export function resolveHmuxBinary(environment = process.env) {
  const candidates = [
    environment.HMUX_BIN,
    join(homedir(), ".local", "bin", "hmux"),
    "hmux",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate === "hmux") return candidate;
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through the bounded candidate list.
    }
  }
  throw new Error("hmux executable was not found; set HMUX_BIN");
}

export function captureSnapshotSeed({
  target,
  workspace,
  discoveryRoot,
  binary = resolveHmuxBinary(),
  execute = execFileSync,
}) {
  if (!target) throw new Error("an Hmux session target is required");
  if (discoveryRoot && !isAbsolute(discoveryRoot)) {
    throw new Error("--discovery-root must be absolute");
  }
  const global = [
    "--json",
    ...(discoveryRoot ? ["--discovery-root", discoveryRoot] : []),
  ];
  const sessions = jsonCommand(binary, [...global, "ls"], execute);
  const eligible = workspace
    ? sessions.filter((session) => session.workspace_id === workspace)
    : sessions;
  const session = resolveSnapshotSession(eligible, target);
  const snapshot = jsonCommand(
    binary,
    [
      ...global,
      "session",
      "snapshot",
      session.session_id,
      "--workspace",
      session.workspace_id,
    ],
    execute,
  );
  return validateSnapshotSeed(snapshot, session);
}

export function resolveSnapshotSession(sessions, target) {
  const exact = sessions.filter((session) => session.session_id === target);
  if (exact.length === 1) return exact[0];
  const named = sessions.filter((session) => session.session_name === target);
  const readyNamed = named.filter((session) => session.lifecycle === "ready");
  if (readyNamed.length === 1) return readyNamed[0];
  if (named.length === 1) return named[0];
  const prefixed = sessions.filter((session) =>
    session.session_id?.startsWith(target),
  );
  if (prefixed.length === 1) return prefixed[0];
  const count = Math.max(exact.length, named.length, prefixed.length);
  throw new Error(
    count > 1
      ? `Hmux session target is ambiguous: ${target}`
      : `Hmux session was not found: ${target}`,
  );
}

function jsonCommand(binary, args, execute) {
  return JSON.parse(
    execute(binary, args, {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    }),
  );
}

export function validateSnapshotSeed(snapshot, session) {
  if (
    snapshot?.schemaVersion !== 1 ||
    snapshot.sessionId !== session.session_id ||
    snapshot.workspaceId !== session.workspace_id ||
    !Number.isInteger(snapshot.rows) ||
    snapshot.rows <= 0 ||
    snapshot.rows > MAX_DIMENSION ||
    !Number.isInteger(snapshot.columns) ||
    snapshot.columns <= 0 ||
    snapshot.columns > MAX_DIMENSION ||
    typeof snapshot.data !== "string" ||
    typeof snapshot.alternateScreen !== "boolean" ||
    typeof snapshot.cursorVisible !== "boolean" ||
    typeof snapshot.truncated !== "boolean"
  ) {
    throw new Error("Hmux returned an invalid canonical snapshot seed");
  }
  const repaintBytes = Buffer.from(snapshot.data, "base64").byteLength;
  if (repaintBytes > MAX_REPAINT_BYTES) {
    throw new Error("Hmux canonical snapshot seed exceeds 512 KiB");
  }
  return snapshot;
}
