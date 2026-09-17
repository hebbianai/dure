import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { exchangeSshBackendRequest } from "../cli/lib/backend-transport.mjs";

afterEach(() => vi.useRealTimers());

it.each(["aborted", "output_limit", "unavailable", "timeout"])(
  "waits for the SSH child to close after %s before releasing its owner",
  async (kind) => {
    vi.useFakeTimers();
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = vi.fn();
    const abort = new AbortController();
    let released = false;
    const pending = exchangeSshBackendRequest(["ssh"], Buffer.from("{}\n"), {
      deadlineMs: 1000,
      maxResponseBytes: 4,
      signal: abort.signal,
      spawnProcess: () => child,
    }).finally(() => {
      released = true;
    });
    if (kind === "aborted") abort.abort();
    else if (kind === "output_limit") child.stdout.write("oversize");
    else if (kind === "unavailable")
      child.emit("error", new Error("owned fixture failure"));
    else await vi.advanceTimersByTimeAsync(1000);
    await Promise.resolve();
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(released).toBe(false);
    child.emit("exit", null, "SIGKILL");
    await Promise.resolve();
    expect(released).toBe(false);
    child.emit("close", null, "SIGKILL");
    expect((await pending).kind).toBe(kind);
    expect(released).toBe(true);
  },
);
