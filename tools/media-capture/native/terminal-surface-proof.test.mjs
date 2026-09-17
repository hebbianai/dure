import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../paths.mjs";
import { runTerminalSurfaceProof } from "./terminal-surface-proof.mjs";

const execFileAsync = promisify(execFile);
const identity = {
  sourceRevision: "a".repeat(40),
  workingTreeFingerprint: `git-working-tree-v1:${"b".repeat(64)}`,
};

describe("native terminal proof failure diagnostics", () => {
  it("retains the redacted bounded tail and exit code after a long build prefix", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-proof-failure-"));
    const failurePath = join(root, "failure.json");
    const stderr = [
      "build progress\n".repeat(2_000),
      "가".repeat(800),
      `${repoRoot}/src/fixture.rs:17`,
      `${homedir()}/.cargo/bin/cargo`,
      "Authorization: Bearer fixture-bearer-secret",
      "OPENAI_API_KEY=fixture-provider-secret",
      "sk-proj-fixtureBareSecret1234567890",
      "assertion failed: final marker was not reached",
    ].join("\n");
    try {
      const error = await runTerminalSurfaceProof({
        ...identity,
        failurePath,
        run: async () => {
          throw Object.assign(new Error("raw-private-cause"), {
            code: 7,
            signal: null,
            stderr,
          });
        },
      }).catch((failure) => failure);

      expect(error.message).toContain("assertion failed: final marker was not reached");
      expect(error.message).toContain("exit=7");
      const receipt = JSON.parse(await readFile(failurePath, "utf8"));
      expect(receipt).toMatchObject({
        ...identity,
        status: "failed",
        exitCode: 7,
        signal: null,
        stderrTruncated: true,
      });
      expect(receipt.stderrTail).toContain("final marker was not reached");
      expect(receipt.stderrTail).toContain("<SOURCE_ROOT>/src/fixture.rs:17");
      expect(receipt.stderrTail).toContain("[REDACTED]");
      expect(Buffer.byteLength(receipt.stderrTail)).toBeLessThanOrEqual(2_000);
      const retained = `${JSON.stringify(receipt)}\n${error.message}`;
      for (const secret of [
        repoRoot, homedir(), "fixture-bearer-secret", "fixture-provider-secret",
        "fixtureBareSecret", "raw-private-cause",
      ]) expect(retained).not.toContain(secret);
      expect(error.cause).toBeUndefined();
      expect((await stat(failurePath)).mode & 0o077).toBe(0);
      expect(receipt).not.toHaveProperty("outputSha256");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("retains a real subprocess termination signal", async () => {
    const error = await runTerminalSurfaceProof({
      ...identity,
      run: () => execFileAsync(process.execPath, [
        "-e",
        "process.stderr.write('fixture interrupted\\n', () => process.kill(process.pid, 'SIGTERM'))",
      ], { encoding: "utf8", timeout: 5_000, maxBuffer: 4_096 }),
    }).catch((failure) => failure);
    expect(error.receipt).toMatchObject({
      status: "failed", exitCode: null, signal: "SIGTERM",
      stderrTail: "fixture interrupted\n",
    });
    expect(error.message).toContain("signal=SIGTERM");
  });

  it("keeps named spawn errors actionable when stderr is empty", async () => {
    const error = await runTerminalSurfaceProof({
      ...identity,
      run: async () => {
        throw Object.assign(new Error("spawn pnpm ENOENT"), { code: "ENOENT", stderr: "" });
      },
    }).catch((failure) => failure);
    expect(error.receipt).toMatchObject({
      exitCode: null, signal: null, errorCode: "ENOENT",
      stderrTail: "spawn pnpm ENOENT",
    });
  });

  it("drops an incomplete credential line before sanitizing the retained window", async () => {
    const error = await runTerminalSurfaceProof({
      ...identity,
      run: async () => {
        throw Object.assign(new Error("overflow"), {
          code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
          stderr: `OPENAI_API_KEY=${"fixture-secret".repeat(1_000)}\nfinal assertion\n`,
        });
      },
    }).catch((failure) => failure);
    expect(error.receipt).toMatchObject({
      errorCode: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      stderrTail: "final assertion\n",
      stderrTruncated: true,
    });
    expect(error.message).not.toContain("fixture-secret");
  });

  it("retains the original diagnostic if the private failure artifact cannot be written", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-proof-write-failure-"));
    try {
      const error = await runTerminalSurfaceProof({
        ...identity,
        failurePath: join(root, "missing-parent", "failure.json"),
        run: async () => {
          throw Object.assign(new Error("failed"), {
            code: 9, stderr: "final assertion",
          });
        },
      }).catch((failure) => failure);
      expect(error.receipt).toMatchObject({ exitCode: 9, stderrTail: "final assertion" });
      expect(error.message).toContain("final assertion");
      expect(error.message).toContain("Failure receipt could not be written.");
      expect(error.message).not.toContain(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves the successful stdout/stderr digest and creates no failure receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-proof-success-"));
    const failurePath = join(root, "failure.json");
    try {
      const result = await runTerminalSurfaceProof({
        ...identity,
        failurePath,
        run: async () => ({ stdout: "passed\n", stderr: "diagnostic\n" }),
      });
      const expected = createHash("sha256")
        .update("dure-native-terminal-surface-proof-v1\0stdout\0passed\n\0stderr\0diagnostic\n")
        .digest("hex");
      expect(result.outputSha256).toBe(expected);
      expect(result.status).toBe("passed");
      await expect(stat(failurePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
