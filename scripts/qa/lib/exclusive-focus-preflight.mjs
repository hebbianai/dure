import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DEFAULT_MINIMUM_IDLE_MS = 15_000;
const MAXIMUM_IDLE_REQUIREMENT_MS = 60 * 60 * 1_000;

function minimumIdleMs(value) {
  if (value === undefined) return DEFAULT_MINIMUM_IDLE_MS;
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 0 ||
    parsed > MAXIMUM_IDLE_REQUIREMENT_MS
  ) {
    throw new Error(
      "HEBBIAN_QA_EXCLUSIVE_MIN_IDLE_MS must be an integer between 0 and 3600000",
    );
  }
  return parsed;
}

export function evaluateExclusiveFocus({
  explicitOptIn,
  idleNanoseconds,
  requiredIdleMs = DEFAULT_MINIMUM_IDLE_MS,
}) {
  if (explicitOptIn !== "1") {
    return { action: "skip", reason: "explicit_opt_in_required" };
  }
  if (typeof idleNanoseconds !== "bigint" || idleNanoseconds < 0n) {
    return { action: "skip", reason: "idle_probe_unavailable" };
  }
  const idleMs = Number(idleNanoseconds / 1_000_000n);
  if (idleMs < requiredIdleMs) {
    return {
      action: "skip",
      reason: "interactive_desktop_active",
      idleMs,
      requiredIdleMs,
    };
  }
  return { action: "run", idleMs, requiredIdleMs };
}

export function parseHidIdleNanoseconds(output) {
  const match = /"HIDIdleTime"\s*=\s*(\d+)/u.exec(String(output));
  return match ? BigInt(match[1]) : undefined;
}

function readHidIdleNanoseconds() {
  try {
    return parseHidIdleNanoseconds(
      execFileSync("/usr/sbin/ioreg", ["-c", "IOHIDSystem"], {
        encoding: "utf8",
        timeout: 2_000,
        maxBuffer: 512 * 1_024,
      }),
    );
  } catch {
    return undefined;
  }
}

function runCli() {
  const decision = evaluateExclusiveFocus({
    explicitOptIn: process.env.HEBBIAN_QA_ALLOW_FOCUS_STEAL,
    idleNanoseconds: readHidIdleNanoseconds(),
    requiredIdleMs: minimumIdleMs(
      process.env.HEBBIAN_QA_EXCLUSIVE_MIN_IDLE_MS,
    ),
  });
  process.stdout.write(`${JSON.stringify(decision)}\n`);
  if (decision.action === "skip") process.exitCode = 20;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    runCli();
  } catch (error) {
    console.error(`hmux exclusive focus preflight failed: ${error}`);
    process.exitCode = 2;
  }
}
