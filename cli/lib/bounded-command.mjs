import { execFile } from "node:child_process";

const DEFAULT_MAX_CAPTURE_BYTES = 1024 * 1024;

/** Run one argv without blocking the event loop and classify every failure. */
export function runBoundedCommand(
  argv,
  { maxCaptureBytes = DEFAULT_MAX_CAPTURE_BYTES, signal, timeoutMs } = {},
) {
  return new Promise((resolve) => {
    if (
      !Array.isArray(argv) ||
      typeof argv[0] !== "string" ||
      !argv[0] ||
      !Number.isFinite(timeoutMs) ||
      timeoutMs < 0
    ) {
      resolve({ kind: "unavailable", stdout: "", stderr: "" });
      return;
    }
    try {
      execFile(
        argv[0],
        argv.slice(1),
        {
          encoding: "utf8",
          killSignal: "SIGKILL",
          maxBuffer: maxCaptureBytes,
          signal,
          timeout: Math.max(1, Math.floor(timeoutMs)),
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve({ kind: "success", stdout, stderr });
            return;
          }
          if (error.name === "AbortError" || error.code === "ABORT_ERR") {
            resolve({ kind: "aborted", stdout, stderr });
            return;
          }
          if (error.killed) {
            resolve({ kind: "timeout", stdout, stderr });
            return;
          }
          if (error.signal) {
            resolve({ kind: "nonzero", signal: error.signal, stdout, stderr });
            return;
          }
          if (Number.isInteger(error.code)) {
            resolve({ kind: "nonzero", code: error.code, stdout, stderr });
            return;
          }
          if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
            resolve({ kind: "output_limit", stdout, stderr });
            return;
          }
          resolve({
            kind: "unavailable",
            message: error.message,
            stdout,
            stderr,
          });
        },
      );
    } catch (error) {
      if (error?.name === "AbortError" || error?.code === "ABORT_ERR") {
        resolve({ kind: "aborted", stdout: "", stderr: "" });
        return;
      }
      resolve({
        kind: "unavailable",
        message: error instanceof Error ? error.message : String(error),
        stdout: "",
        stderr: "",
      });
    }
  });
}
