import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const boundary = fileURLToPath(new URL("../native/linux-process-boundary.py", import.meta.url));
const loadBoundary = `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("boundary", sys.argv[1])
boundary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(boundary)
`;

function run(source, ...arguments_) {
  return spawnSync("python3", ["-I", "-S", "-B", "-c", loadBoundary + source, boundary, ...arguments_], {
    encoding: "utf8", timeout: 10_000,
  });
}

describe("Linux point observation during cwd withdrawal", () => {
  function observe(state, error = "ENOENT", ticks = "123") {
    return run(`
import errno
boundary.read_boot_id = lambda: "fixture-boot"
boundary.read_boot_time_seconds = lambda: 1000
boundary.read_clock_ticks_per_second = lambda: 100
boundary.open_proc_directory = lambda pid: 77
boundary.os.close = lambda descriptor: None
def identity(state, ticks):
    return dict(state=state, start_ticks=ticks, parent=2, group=3, session=3)
after = None if sys.argv[2] == "absent" else identity(sys.argv[2], sys.argv[4])
reads = iter([identity("R", "123"), after])
boundary.read_process_identity_from_directory = lambda descriptor: next(reads)
def unavailable(*args, **kwargs):
    raise OSError(getattr(errno, sys.argv[3]), "cwd withdrawn")
boundary.os.readlink = unavailable
boundary.observe_points(["42"], include_cwd=True)
`, state, error, ticks);
  }

  it("reports the same generation as a zombie after its cwd disappears", () => {
    const result = observe("Z");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("M 42 2 3 3 zombie linux:fixture-boot:123 1001 -");
  });

  it("omits a process that has already been reaped", () => {
    const result = observe("absent");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
  });

  it.each(["ENOENT", "EACCES", "EIO"])("retains a live %s cwd failure as unknown", error => {
    const result = observe("R", error);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("process cwd unavailable");
    expect(result.stdout).toBe("");
  });

  it("does not use a different generation's zombie state to discharge the original", () => {
    const result = observe("Z", "ENOENT", "456");
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
  });

  it.runIf(process.platform === "linux")("observes a real child exiting between identity and cwd reads", () => {
    const result = run(`
import os
read, write = os.pipe()
child = os.fork()
if child == 0:
    os.close(write)
    os.read(read, 1)
    os._exit(0)
os.close(read)
readlink = os.readlink
def exit_before_cwd(*args, **kwargs):
    global write
    os.close(write)
    write = None
    os.waitid(os.P_PID, child, os.WEXITED | os.WNOWAIT)
    return readlink(*args, **kwargs)
boundary.os.readlink = exit_before_cwd
try:
    boundary.observe_points([str(child)], include_cwd=True)
finally:
    if write is not None:
        os.close(write)
    os.waitpid(child, 0)
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toMatch(/^M \d+ \d+ \d+ \d+ zombie linux:[^ ]+ \d+ -$/u);
  });
});
