import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

export const execFileAsync = promisify(execFile);

export function parseFrameRate(value) {
  const [numerator, denominator] = String(value).split("/").map(Number);
  return denominator > 0 ? numerator / denominator : Number.NaN;
}

export async function ffmpegVersion(binary, purpose, signal) {
  try {
    const { stdout } = await execFileAsync(binary, ["-version"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      signal,
      timeout: 10_000,
    });
    return {
      version: stdout.split(/\r?\n/u)[0]?.trim() ?? "unknown",
      buildFingerprint: `sha256:${createHash("sha256").update(stdout).digest("hex")}`,
    };
  } catch (error) {
    throw new Error(`${purpose} requires ${binary}`, { cause: error });
  }
}
