import { spawn } from "node:child_process";

/** Settle only after close, so the connection can release its SSH material. */
export function exchangeSshStdio(
  argv,
  input,
  { deadlineMs, maxResponseBytes, signal, spawnProcess = spawn },
) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ kind: "aborted", stdout: Buffer.alloc(0) });
      return;
    }
    let child;
    let failure;
    let stdoutSize = 0;
    let stderrSize = 0;
    const stdout = [];
    const stop = (kind) => {
      if (failure) return;
      failure = kind;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    };
    const onAbort = () => stop("aborted");
    const timer = setTimeout(() => stop("timeout"), deadlineMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (code, closeSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({
        kind: failure ?? (code === 0 ? "success" : "nonzero"),
        ...(failure ? {} : { code, signal: closeSignal }),
        stdout: Buffer.concat(stdout),
      });
    };
    try {
      child = spawnProcess(argv[0], argv.slice(1), {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      child.stdout.on("data", (chunk) => {
        if (failure) return;
        stdoutSize += chunk.byteLength;
        if (stdoutSize > maxResponseBytes) {
          stop("output_limit");
          return;
        }
        stdout.push(Buffer.from(chunk));
      });
      // SSH stderr is not returned: count it without retaining credential or path diagnostics.
      child.stderr.on("data", (chunk) => {
        if (failure) return;
        stderrSize += chunk.byteLength;
        if (stderrSize > maxResponseBytes) stop("output_limit");
      });
      child.once("error", () => stop("unavailable"));
      child.once("close", finish);
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    } catch {
      stop("unavailable");
      if (!child) finish();
    }
  });
}
