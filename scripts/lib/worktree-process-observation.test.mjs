import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  macosProcessBoundaryCompileArguments,
  processMemberSnapshots,
} from "./process-identity.mjs";
import { observeWorktreeProcesses } from "./worktree-inventory.mjs";

const pathWork = vi.hoisted(() => ({ relativeCalls: 0 }));
vi.mock("node:path", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    relative: (...args) => {
      pathWork.relativeCalls += 1;
      return original.relative(...args);
    },
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    execFileSync: vi.fn(original.execFileSync),
    spawnSync: vi.fn(original.spawnSync),
  };
});

it("maps a large live census without resolving every worktree-process pair", () => {
  const roots = Array.from({ length: 626 }, (_, index) =>
    join(tmpdir(), "dure-census-fixture", `worktree-${String(index).padStart(4, "0")}`),
  );
  const pids = Array.from({ length: 1_205 }, (_, index) => index + 10_000);
  const cwd = join(roots.at(-1), "src", "nested");
  pathWork.relativeCalls = 0;
  const observed = observeWorktreeProcesses(roots, {
    psRunner: () => pids.map((pid) => `${pid} 1 node fixture`).join("\n"),
    memberRunner: (requestedPids) => ({
      status: "complete",
      scope: { kind: "point", requestedPids },
      members: requestedPids.map((pid) => ({
        pid,
        cwd,
        state: "live",
        processIdentity: `fixture:${pid}`,
      })),
    }),
  });
  expect(observed).toEqual({
    status: "complete",
    scope: roots,
    worktrees: roots.map((path) => ({
      path,
      pids: path === roots.at(-1) ? pids : [],
      roles: path === roots.at(-1) ? ["live"] : [],
    })),
  });
  expect(pathWork.relativeCalls).toBeLessThanOrEqual(pids.length * 4);
}, 15_000);

describe("worktree CWD assignment semantics", () => {
  const root = join(tmpdir(), "dure-census-boundaries");
  const child = join(root, "child");
  const special = join(root, " space 한글\n\t");
  const volume = parse(root).root;
  const cases = [
    ["nearest registered ancestor", [root, child], join(child, "src"), child],
    ["component boundary", [root, child], join(`${child}-other`, "src"), root],
    ["dot segments", [root, child], `${child}/../src`, root],
    ["whitespace and Unicode", [root, special], join(special, "src"), special],
    ["volume root", [volume], root, volume],
    ["unregistered sibling", [root], `${root}-other`, null],
    ...(process.platform === "win32"
      ? [[
          "first case-insensitive alias",
          [root.toUpperCase(), root],
          root,
          root.toUpperCase(),
        ]]
      : [["case-sensitive path", [root], root.toUpperCase(), null]]),
  ];
  it.each(cases)("preserves %s ownership", (_label, roots, cwd, owner) => {
    const observation = observeWorktreeProcesses(roots, {
      psRunner: () => "42 1 node fixture",
      memberRunner: (requestedPids) => ({
        status: "complete",
        scope: { kind: "point", requestedPids },
        members: [{ pid: 42, cwd, state: "live", processIdentity: "fixture:42" }],
      }),
    });
    expect(observation).toEqual({
      status: "complete",
      scope: roots,
      worktrees: roots.map((path) => ({
        path,
        pids: path === owner ? [42] : [],
        roles: path === owner ? ["live"] : [],
      })),
    });
  });
});

describe.runIf(["darwin", "linux"].includes(process.platform))(
  "worktree process observation cost",
  () => {
    beforeAll(() => {
      expect(processMemberSnapshots([process.pid]).status).toBe("complete");
    });

    it("observes a live worktree without launching an open-file census", () => {
      const cwd = realpathSync(process.cwd());
      vi.mocked(execFileSync).mockClear();
      vi.mocked(spawnSync).mockClear();

      const observed = observeWorktreeProcesses([cwd], {
        psRunner: () => `${process.pid} ${process.ppid} node fixture`,
      });

      expect(observed).toEqual({
        status: "complete",
        scope: [cwd],
        worktrees: [{ path: cwd, pids: [process.pid], roles: ["live"] }],
      });
      const commands = [
        ...vi.mocked(execFileSync).mock.calls,
        ...vi.mocked(spawnSync).mock.calls,
      ].map(([command]) => basename(String(command)));
      expect(commands.filter((command) => command === "lsof")).toEqual([]);
    });

    it("combines bounded point batches and omits proven absent processes", () => {
      const absent = Array.from({ length: 257 }, (_, index) => 2_000_000_000 + index);
      vi.mocked(spawnSync).mockClear();
      const observed = processMemberSnapshots(
        [process.pid, ...absent], process.platform, { includeCwd: true },
      );
      expect(observed.status).toBe("complete");
      expect(observed.members).toHaveLength(1);
      expect(observed.members[0]).toMatchObject({
        pid: process.pid,
        cwd: realpathSync(process.cwd()),
      });
      const batches = vi.mocked(spawnSync).mock.calls.map(([, args]) =>
        args.slice(args.indexOf("observe-point-cwd") + 1),
      );
      expect(batches.map((batch) => batch.length)).toEqual([256, 2]);
    });

    it("preserves whitespace and Unicode paths in the same generation-bound observation", async () => {
      const root = mkdtempSync(join(realpathSync(tmpdir()), "dure-process-cwd-"));
      const cwd = join(root, "space 한글\nline\ttab ");
      mkdirSync(cwd);
      const child = spawn(process.execPath, [
        "-e",
        'process.send("ready"); process.on("message", () => process.exit(0));',
      ], { cwd, stdio: ["ignore", "ignore", "ignore", "ipc"] });
      const exited = once(child, "exit");
      try {
        await once(child, "message");
        const observed = processMemberSnapshots(
          [child.pid], process.platform, { includeCwd: true },
        );
        expect(observed.status).toBe("complete");
        expect(observed.members).toHaveLength(1);
        expect(observed.members[0]).toMatchObject({
          pid: child.pid, cwd, state: "live",
        });
        expect(observed.members[0].processIdentity).toBeTruthy();
      } finally {
        if (child.connected) child.send("finish");
        await exited;
        rmSync(root, { force: true, recursive: true });
      }
      const absent = processMemberSnapshots(
        [child.pid], process.platform, { includeCwd: true },
      );
      expect(absent).toMatchObject({ status: "complete", members: [] });
    });

    it("rejects missing, malformed, or duplicate CWD metadata rather than inventing idle state", () => {
      const identity = process.platform === "darwin"
        ? "kernel-start-v3:macos:11111111-1111-1111-1111-111111111111:42"
        : "linux:fixture-boot:42";
      const member = `M ${process.pid} 1 42 42 live ${identity} 1`;
      for (const output of [
        member, `${member} -`, `${member} f`, `${member} ff`,
        `${member} 2f00`, `${member} 2f\n${member} 2f`,
      ]) {
        vi.mocked(spawnSync).mockReturnValueOnce({ status: 0, stdout: output });
        expect(processMemberSnapshots([process.pid], process.platform, { includeCwd: true }).status)
          .toBe("incomplete");
      }
      vi.mocked(spawnSync).mockReturnValueOnce({ status: 15, stdout: `${member} 2f` });
      expect(processMemberSnapshots([process.pid], process.platform, { includeCwd: true }).status)
        .toBe("incomplete");
    });

    it("retains zombie identity without requiring a CWD", () => {
      const identity = process.platform === "darwin"
        ? "kernel-start-v3:macos:11111111-1111-1111-1111-111111111111:42"
        : "linux:fixture-boot:42";
      vi.mocked(spawnSync).mockReturnValueOnce({
        status: 0,
        stdout: `M ${process.pid} 1 42 42 zombie ${identity} 1 -`,
      });
      expect(processMemberSnapshots(
        [process.pid], process.platform, { includeCwd: true },
      )).toMatchObject({
        status: "complete",
        members: [{ pid: process.pid, state: "zombie", cwd: null }],
      });
    });
  },
);

describe.runIf(process.platform === "darwin")("native CWD generation fence", () => {
  let root;
  let executable;
  beforeAll(() => {
    root = mkdtempSync(join(realpathSync(tmpdir()), "dure-cwd-fence-"));
    executable = join(root, "observer");
    const compiled = spawnSync("cc", [
      "-DDURE_OWNERSHIP_OBSERVER_FAULT_INJECTION=1",
      ...macosProcessBoundaryCompileArguments(executable),
    ], { encoding: "utf8", timeout: 30_000 });
    expect(compiled.status, compiled.stderr).toBe(0);
  });
  afterAll(() => {
    if (root) rmSync(root, { force: true, recursive: true });
  });

  it.each(["cwd-read-failed", "cwd-generation-drift"])(
    "fails closed on %s before publishing a member",
    (fault) => {
      const observed = spawnSync(executable, [
        "observe-point-cwd", String(process.pid),
      ], {
        encoding: "utf8",
        env: { ...process.env, DURE_QA_NATIVE_OWNERSHIP_OBSERVER_FAULT: fault },
        timeout: 2_000,
      });
      expect(observed.status).toBe(15);
      expect(observed.stdout).toBe("");
    },
  );
});

it.runIf(["darwin", "linux"].includes(process.platform))(
  "keeps Linux CWD reads on the pinned process directory and rejects generation drift",
  () => {
    const boundary = fileURLToPath(
      new URL("../native/linux-process-boundary.py", import.meta.url),
    );
    const result = spawnSync("python3", ["-c", String.raw`
import contextlib, io, os, runpy, sys, tempfile
from unittest.mock import patch

observe = runpy.run_path(sys.argv[1])["observe_points"]
scope = observe.__globals__
identity = dict(state="R", parent=1, group=42, session=42, start_ticks="50")
scope.update(read_boot_id=lambda: "fixture-boot", read_boot_time_seconds=lambda: 100,
             read_clock_ticks_per_second=lambda: 100)
path = "/worktree/space 한글\nline\ttab "
with tempfile.TemporaryDirectory(prefix="dure-linux-cwd-") as root:
    os.symlink(path, os.path.join(root, "cwd"))
    for mode in ("live", "drift", "gone", "denied", "zombie"):
        fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
        scope["open_proc_directory"] = lambda pid: fd
        before = dict(identity, state="Z") if mode == "zombie" else identity
        after = dict(identity, start_ticks="51") if mode == "drift" else identity
        if mode == "gone":
            after = None
        reads = iter((before, after))
        scope["read_process_identity_from_directory"] = lambda anchor: next(reads)
        output, errors, status = io.StringIO(), io.StringIO(), 0
        real_readlink = os.readlink
        def readlink(name, *, dir_fd):
            assert name == "cwd" and dir_fd == fd
            if mode == "denied":
                raise PermissionError(13, "fixture denied")
            return real_readlink(name, dir_fd=dir_fd)
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            with patch.object(os, "readlink", side_effect=readlink) as link:
                try:
                    observe(["42"], include_cwd=True)
                except SystemExit as error:
                    status = error.code
        assert status == (5 if mode in ("drift", "denied") else 0), (mode, errors.getvalue())
        if mode == "live":
            assert output.getvalue().endswith(" " + os.fsencode(path).hex() + "\n")
        elif mode == "zombie":
            assert output.getvalue().endswith(" -\n") and link.call_count == 0
        else:
            assert output.getvalue() == "", (mode, output.getvalue())
        try:
            os.fstat(fd)
            raise AssertionError("process directory was not closed")
        except OSError as error:
            assert error.errno == 9
print("live drift gone denied zombie: passed")
`, boundary], { encoding: "utf8", timeout: 5_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("live drift gone denied zombie: passed");
  },
);
