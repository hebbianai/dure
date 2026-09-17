import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const adapters = vi.hoisted(() => ({
  launch: vi.fn(),
  build: vi.fn(),
  artifacts: vi.fn(),
  storage: vi.fn(),
}));
vi.mock("../run-hmux-tests.mjs", () => ({
  runLauncher: adapters.launch,
  hmuxTestBinaries: () => ({}),
}));
vi.mock("../run-with-build-storage.mjs", () => ({ runWithBuildStorage: adapters.storage }));
vi.mock("./managed-provider-fixture.mjs", () => ({
  cargoArtifact: adapters.build,
  cargoArtifacts: adapters.artifacts,
}));

const repository = path.resolve(import.meta.dirname, "../..");
const script = path.join(import.meta.dirname, "hmux-rehost-cli-smoke.mjs");
let root;
let receipt;
let prepared;
let originalArgv;
let originalExitCode;

beforeEach(() => {
  vi.clearAllMocks();
  adapters.launch.mockResolvedValue(0);
  adapters.storage.mockReturnValue(0);
  originalArgv = process.argv;
  originalExitCode = process.exitCode;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rehost-qa-command-")));
  receipt = path.join(root, "prepared.json");
  const artifact = (name) => {
    const executable = path.join(root, name);
    fs.writeFileSync(executable, `#!/bin/sh\nexit 0\n# ${name}\n`, { mode: 0o700 });
    return {
      path: executable,
      sha256: createHash("sha256").update(fs.readFileSync(executable)).digest("hex"),
    };
  };
  prepared = {
    schemaVersion: 1,
    kind: "dure.qa.rehost.prepared",
    worktree: fs.realpathSync(repository),
    artifacts: { cli: artifact("hmux"), runtime: artifact("hmux-runtime"), test: artifact("managed_smoke") },
  };
  fs.writeFileSync(receipt, JSON.stringify(prepared), { mode: 0o600 });
  vi.stubEnv("DURE_HMUX_TEST_STATE_ROOT", "");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  for (const [line] of console.log.mock.calls) {
    let report;
    try { report = JSON.parse(line); } catch { continue; }
    if (report.kind === "dure.qa.rehost.result" && report.timingRoot) {
      expect(path.basename(report.timingRoot)).toMatch(/^dure-rehost-timing-/u);
      expect(fs.realpathSync(path.dirname(report.timingRoot))).toBe(fs.realpathSync(os.tmpdir()));
      fs.rmSync(report.timingRoot, { recursive: true, force: true });
    }
  }
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

async function invoke(...args) {
  vi.resetModules();
  process.argv = [process.execPath, script, ...args];
  process.exitCode = undefined;
  try {
    await import("./hmux-rehost-cli-smoke.mjs");
    return { status: process.exitCode ?? 0 };
  } catch (error) {
    return { status: 1, error: error.message };
  }
}

test("prepared execution repeats the named case without Cargo or build admission", async () => {
  expect(await invoke("run", receipt, "named")).toEqual({ status: 0 });
  expect(await invoke("run", receipt, "named")).toEqual({ status: 0 });
  expect(adapters.build).not.toHaveBeenCalled();
  expect(adapters.artifacts).not.toHaveBeenCalled();
  expect(adapters.storage).not.toHaveBeenCalled();
  expect(adapters.launch).toHaveBeenCalledTimes(2);
  for (const [command, options] of adapters.launch.mock.calls) {
    expect(command).toEqual([
      process.execPath, script, "--case", "named", prepared.artifacts.test.path, expect.any(String),
    ]);
    expect(options.environment).toMatchObject({
      DURE_QA_HMUX_BIN: prepared.artifacts.cli.path,
      DURE_QA_HMUX_RUNTIME: prepared.artifacts.runtime.path,
    });
  }
  expect(adapters.launch.mock.calls[0][0][5]).not.toBe(adapters.launch.mock.calls[1][0][5]);
});

test("prepared execution keeps one guardian per existing case group", async () => {
  expect(await invoke("run", receipt)).toEqual({ status: 0 });
  expect(adapters.launch.mock.calls.map(([command]) => command[3]))
    .toEqual(["admission", "start", "retry", "named", "wait"]);
  expect(adapters.storage).not.toHaveBeenCalled();
});

test("prepared execution stops at the original failed group without retrying", async () => {
  adapters.launch.mockResolvedValueOnce(0).mockResolvedValueOnce(42);
  expect(await invoke("run", receipt)).toEqual({ status: 42 });
  expect(adapters.launch).toHaveBeenCalledTimes(2);
  expect(adapters.build).not.toHaveBeenCalled();
});

test.each(["cli", "runtime", "test"])("refuses changed %s bytes without rebuilding or launching", async (name) => {
  fs.appendFileSync(prepared.artifacts[name].path, "# changed\n");
  expect(await invoke("run", receipt, "named")).toEqual({ status: 1 });
  expect(adapters.launch).not.toHaveBeenCalled();
  expect(adapters.build).not.toHaveBeenCalled();
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining(`Prepared ${name} changed`));
});

test("refuses another checkout's prepared test before launching", async () => {
  prepared.worktree = root;
  fs.writeFileSync(receipt, JSON.stringify(prepared));
  expect(await invoke("run", receipt)).toEqual({ status: 1 });
  expect(adapters.launch).not.toHaveBeenCalled();
});

test("does not silently prepare when the explicit receipt is missing", async () => {
  expect(await invoke("run", path.join(root, "missing.json"))).toEqual({ status: 1 });
  expect(adapters.launch).not.toHaveBeenCalled();
  expect(adapters.build).not.toHaveBeenCalled();
});

test("rejects an unknown group before preparing or launching", async () => {
  expect(await invoke("run", receipt, "typo")).toEqual({ status: 1 });
  expect(adapters.launch).not.toHaveBeenCalled();
});

test("prepare retains build admission and a failure never reaches execution", async () => {
  adapters.launch.mockResolvedValueOnce(43);
  const output = path.join(root, "new.json");
  expect(await invoke("prepare", output)).toEqual({ status: 43 });
  expect(adapters.launch).toHaveBeenCalledExactlyOnceWith([
    process.execPath, "scripts/run-with-build-storage.mjs", "qa", "--",
    process.execPath, script, "--build", output, expect.any(String),
  ], undefined);
  expect(fs.existsSync(output)).toBe(false);
});

test("does not overwrite an existing receipt or build first", async () => {
  const before = fs.readFileSync(receipt);
  expect(await invoke("prepare", receipt)).toEqual({ status: 1 });
  expect(adapters.launch).not.toHaveBeenCalled();
  expect(fs.readFileSync(receipt)).toEqual(before);
});

test("a successful preparer without usable artifacts is still a failed report", async () => {
  const output = path.join(root, "new.json");
  expect(await invoke("prepare", output)).toEqual({ status: 1 });
  const report = JSON.parse(console.log.mock.calls.at(-1)[0]);
  expect(report.status).toBe(1);
  expect(report.qaExecution.failureClass).toBe("qa_runner");
  expect(adapters.launch).toHaveBeenCalledTimes(1);
});

test("build preparation selects Cargo artifacts without executing any scenario", async () => {
  const output = path.join(root, "new.json");
  vi.stubEnv("DURE_HMUX_TEST_STATE_ROOT", root);
  adapters.build.mockResolvedValue(prepared.artifacts.cli.path);
  adapters.artifacts.mockResolvedValue([
    { target: { name: "managed_smoke" }, executable: prepared.artifacts.test.path },
    { target: { name: "hmux-runtime" }, executable: prepared.artifacts.runtime.path },
  ]);
  expect(await invoke("--build", output)).toEqual({ status: 0 });
  expect(adapters.build).toHaveBeenCalledWith(expect.arrayContaining(["build", "hmux-cli"]), "hmux", { kind: "qa" });
  expect(adapters.artifacts).toHaveBeenCalledWith(
    expect.arrayContaining(["test", "--no-run", "terminal-state-stream", "managed_smoke"]), { kind: "qa" },
  );
  expect(adapters.launch).not.toHaveBeenCalled();
  expect(JSON.parse(fs.readFileSync(output, "utf8"))).toMatchObject(prepared);
  expect(fs.statSync(output).mode & 0o777).toBe(0o600);
});

function executableFixture({ listed = true, status = 0 } = {}) {
  const executable = path.join(root, "test-executable");
  const capture = path.join(root, "test-call.json");
  const filter = "rehost_cli::named::confirmed_name_pins_execution_and_publication";
  fs.writeFileSync(executable, `#!${process.execPath}
import fs from "node:fs";
if (process.argv.includes("--list")) {
  console.log(${JSON.stringify(listed ? `${filter}: test\n1 test, 0 benchmarks` : "0 tests, 0 benchmarks")});
} else {
  fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({
    args: process.argv.slice(2), home: process.env.HOME, dure: process.env.DURE_HOME,
    discovery: process.env.HMUX_DISCOVERY_ROOT, group: process.env.DURE_QA_REHOST_GROUP,
  }));
  process.exitCode = ${status};
}
`, { mode: 0o700 });
  vi.stubEnv("DURE_HMUX_TEST_STATE_ROOT", root);
  vi.stubEnv("HMUX_DISCOVERY_ROOT", path.join(root, "discovery"));
  return { executable, capture, filter };
}

test("runs the exact compiled case inside the guardian's disposable environment", async () => {
  const { executable, capture, filter } = executableFixture({ status: 42 });
  expect(await invoke("--case", "named", executable)).toEqual({ status: 42 });
  expect(JSON.parse(fs.readFileSync(capture, "utf8"))).toEqual({
    args: [filter, "--ignored", "--exact", "--nocapture"],
    home: path.join(root, "provider-home"), dure: path.join(root, "provider-home/dure"),
    discovery: path.join(root, "discovery"), group: "named",
  });
  expect(adapters.build).not.toHaveBeenCalled();
  expect(adapters.storage).not.toHaveBeenCalled();
});

test("a missing test filter cannot pass as a zero-test execution", async () => {
  const { executable, capture } = executableFixture({ listed: false });
  expect(await invoke("--case", "named", executable)).toEqual({ status: 1 });
  expect(fs.existsSync(capture)).toBe(false);
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining("zero-test success"));
});

test.each([0, 42])("reports startup, verification and cleanup separately without changing status %s", async (status) => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
  adapters.launch.mockImplementation(async (command) => {
    if (command[5]) fs.writeFileSync(command[5], JSON.stringify({ startedAtMs: 1200, finishedAtMs: 1500 }));
    clock.mockReturnValue(1800);
    return status;
  });
  expect(await invoke("run", receipt, "named")).toEqual({ status });
  const report = JSON.parse(console.log.mock.calls.at(-1)[0]);
  expect(report.steps).toEqual([expect.objectContaining({
    name: "named", status,
    qaExecution: expect.objectContaining({ phaseDurationsMs: { startup: 200, verification: 300, cleanup: 300 } }),
  })]);
  expect(adapters.launch).toHaveBeenCalledTimes(1);
});

test("reports the build command separately from its guardian startup and cleanup", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
  const output = path.join(root, "new.json");
  adapters.launch.mockImplementation(async (command) => {
    fs.writeFileSync(output, JSON.stringify(prepared));
    const timingFile = command.at(-1);
    if (timingFile !== output) fs.writeFileSync(timingFile, JSON.stringify({ startedAtMs: 1200, finishedAtMs: 2100 }));
    clock.mockReturnValue(2500);
    return 0;
  });
  expect(await invoke("prepare", output)).toEqual({ status: 0 });
  const report = JSON.parse(console.log.mock.calls.at(-1)[0]);
  expect(report.steps).toEqual([expect.objectContaining({
    name: "prepare", status: 0,
    qaExecution: expect.objectContaining({ phaseDurationsMs: { startup: 200, build: 900, cleanup: 400 } }),
  })]);
});

test.each([null, { startedAtMs: 1200 }, { startedAtMs: 1600, finishedAtMs: 1500 }])(
  "missing or interrupted timing stays unavailable and cannot hide cleanup failure: %j", async (timing) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    adapters.launch.mockImplementation(async (command) => {
      if (timing) fs.writeFileSync(command[5], JSON.stringify(timing));
      clock.mockReturnValue(1800);
      return 97;
    });
    expect(await invoke("run", receipt, "named")).toEqual({ status: 97 });
    const report = JSON.parse(console.log.mock.calls.at(-1)[0]);
    expect(report.steps).toEqual([{
      name: "named", status: 97, qaExecution: null,
      timingError: { code: "qa_phase_timing_unavailable", message: expect.any(String) },
    }]);
    expect(adapters.launch).toHaveBeenCalledTimes(1);
    expect(adapters.build).not.toHaveBeenCalled();
  },
);

test("the existing child records the actual compiled-command interval even when the test fails", async () => {
  const { executable } = executableFixture({ status: 42 });
  const timingFile = path.join(root, "timing.json");
  const before = Date.now();
  expect(await invoke("--case", "named", executable, timingFile)).toEqual({ status: 42 });
  const timing = JSON.parse(fs.readFileSync(timingFile, "utf8"));
  expect(timing.startedAtMs).toBeGreaterThanOrEqual(before);
  expect(timing.finishedAtMs).toBeGreaterThanOrEqual(timing.startedAtMs);
  expect(timing.finishedAtMs).toBeLessThanOrEqual(Date.now());
  expect(fs.statSync(timingFile).mode & 0o777).toBe(0o600);
});

test.each(["existing", "unwritable"])("%s timing output cannot block the test or overwrite evidence", async (kind) => {
  const { executable, capture } = executableFixture({ status: 42 });
  const timingFile = path.join(root, kind === "existing" ? "previous.json" : "absent/timing.json");
  if (kind === "existing") fs.writeFileSync(timingFile, "previous evidence");
  expect(await invoke("--case", "named", executable, timingFile)).toEqual({ status: 42 });
  expect(fs.existsSync(capture)).toBe(true);
  if (kind === "existing") expect(fs.readFileSync(timingFile, "utf8")).toBe("previous evidence");
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining("qa_phase_timing_unavailable"));
});

test("refuses a case without the existing guardian's isolated root", async () => {
  expect(await invoke("--case", "named", prepared.artifacts.test.path)).toEqual({ status: 1 });
  expect(fs.existsSync(path.join(root, "provider-home"))).toBe(false);
});
