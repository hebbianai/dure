import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, homedir, tmpdir } from "node:os";
import { promisify } from "node:util";
import { withoutLocalGitOverrides } from "../../../scripts/lib/git-environment.mjs";
import {
  boundQaEvidenceText,
  redactQaEvidenceText,
} from "../../../scripts/qa/lib/evidence-bundle.mjs";
import { repoRoot } from "../paths.mjs";
import {
  providerPrivacyViolations,
  visibleProviderText,
} from "../providers/privacy.mjs";
import { writeJsonAtomic } from "./output.mjs";

const execFileAsync = promisify(execFile);
const PROOF_TARGET = "hmux-webview-recovery-smoke";
const SOURCE_REVISION = /^[0-9a-f]{40}$/u;
const WORKING_TREE_FINGERPRINT = /^git-working-tree-v1:[0-9a-f]{64}$/u;
const MAX_DIAGNOSTIC_BYTES = 2_000;

function failureDiagnostic(error) {
  let text = String(error?.stderr || error?.message || "subprocess failed");
  const prefixTruncated = text.length > MAX_DIAGNOSTIC_BYTES * 4;
  if (prefixTruncated) {
    text = text.slice(-MAX_DIAGNOSTIC_BYTES * 4);
    // Discard a partial first line: its credential label may be outside the window.
    const newline = text.indexOf("\n");
    text = newline < 0 ? "" : text.slice(newline + 1);
  }
  const redacted = redactQaEvidenceText(visibleProviderText(text), [
    { value: repoRoot, replacement: "<SOURCE_ROOT>" },
    { value: homedir(), replacement: "<HOME>" },
    { value: tmpdir(), replacement: "<TMP>" },
  ])
    .split("\n")
    .map((line) =>
      providerPrivacyViolations(line).some(
        (kind) => kind !== "ambient lifecycle hook failure",
      )
        ? "[REDACTED]"
        : line,
    )
    .join("\n");
  const bounded = boundQaEvidenceText(redacted, MAX_DIAGNOSTIC_BYTES);
  return {
    exitCode: Number.isInteger(error?.code) && error.code >= 0 ? error.code : null,
    errorCode:
      typeof error?.code === "string" && /^E[A-Z0-9_]{1,63}$/u.test(error.code)
        ? error.code
        : null,
    signal:
      typeof error?.signal === "string" && Object.hasOwn(constants.signals, error.signal)
        ? error.signal
        : null,
    stderrTail: bounded.contents,
    stderrTruncated: prefixTruncated || bounded.truncated,
  };
}

async function defaultRun() {
  return execFileAsync("pnpm", ["test:hmux-webview-recovery"], {
    cwd: new URL("../../../", import.meta.url),
    encoding: "utf8",
    env: withoutLocalGitOverrides(process.env),
    maxBuffer: 32 * 1024 * 1024,
    timeout: 15 * 60_000,
  });
}

function outputDigest(stdout, stderr) {
  const hash = createHash("sha256");
  hash.update("dure-native-terminal-surface-proof-v1\0stdout\0");
  hash.update(stdout ?? "");
  hash.update("\0stderr\0");
  hash.update(stderr ?? "");
  return hash.digest("hex");
}

export async function runTerminalSurfaceProof({
  failurePath,
  now = Date.now,
  run = defaultRun,
  sourceRevision,
  workingTreeFingerprint,
} = {}) {
  if (!SOURCE_REVISION.test(sourceRevision ?? "")) {
    throw new Error("native terminal surface proof source revision is invalid");
  }
  if (!WORKING_TREE_FINGERPRINT.test(workingTreeFingerprint ?? "")) {
    throw new Error("native terminal surface proof working-tree fingerprint is invalid");
  }
  const startedAt = now();
  let result;
  try {
    result = await run();
  } catch (error) {
    const completedAt = now();
    const receipt = {
      schemaVersion: 1,
      command: ["pnpm", "test:hmux-webview-recovery"],
      completedAt: new Date(completedAt).toISOString(),
      durationMs: Math.max(0, completedAt - startedAt),
      proofTarget: PROOF_TARGET,
      sourceRevision,
      status: "failed",
      workingTreeFingerprint,
      ...failureDiagnostic(error),
    };
    const failure = Object.assign(
      new Error(
        `native terminal surface proof failed (exit=${receipt.exitCode ?? "unknown"}, signal=${receipt.signal ?? "none"}, code=${receipt.errorCode ?? "none"}):\n${receipt.stderrTail}`,
      ),
      { receipt },
    );
    if (failurePath) {
      try {
        await writeJsonAtomic(failurePath, receipt);
      } catch {
        failure.message += "\nFailure receipt could not be written.";
      }
    }
    throw failure;
  }
  const completedAt = now();
  return {
    schemaVersion: 1,
    command: ["pnpm", "test:hmux-webview-recovery"],
    completedAt: new Date(completedAt).toISOString(),
    durationMs: Math.max(0, completedAt - startedAt),
    outputSha256: outputDigest(result.stdout, result.stderr),
    proofTarget: PROOF_TARGET,
    sourceRevision,
    status: "passed",
    workingTreeFingerprint,
  };
}
