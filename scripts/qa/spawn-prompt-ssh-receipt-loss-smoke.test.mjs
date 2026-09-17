import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const sourceRoot = path.dirname(fileURLToPath(import.meta.url));
const wrapperSource = path.join(
  sourceRoot,
  "spawn-prompt-ssh-receipt-loss-smoke.sh",
);
const guestSetupSource = path.join(
  sourceRoot,
  "spawn-prompt-ssh-guest-setup.sh",
);
const roots = [];
const fixtureRoots = [];

function executable(file, source) {
  fs.writeFileSync(file, source, { mode: 0o755 });
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function stopLeakedRunnerChild(root) {
  const pidPath = path.join(root, "runner-child.pid");
  if (!fs.existsSync(pidPath)) return;
  const pid = Number(fs.readFileSync(pidPath, "utf8").trim());
  if (!Number.isSafeInteger(pid) || pid <= 1 || !processExists(pid)) return;
  const observed = spawnSync("ps", ["-o", "command=", "-p", String(pid)], {
    encoding: "utf8",
  });
  if (observed.status === 0 && observed.stdout.includes(root)) {
    process.kill(pid, "SIGKILL");
  }
}

function fixture({
  hostKeyMismatch = false,
  listFailure = false,
  commandRootFailureAfterRunner = false,
  ownedFailure = false,
  runnerCleanupFailure = false,
  scpHang = false,
  sshStatus97 = false,
  sshHang = false,
  startFailure = false,
  startPathMustFit = false,
  startWitnessMustBeClosed = false,
  staleQaLog = false,
  stickyDelete = false,
  wrapperHup = false,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-ssh-wrapper-"));
  roots.push(root);
  const repository = path.join(root, "repo");
  const qa = path.join(repository, "scripts", "qa");
  const bin = path.join(root, "bin");
  const tmp = path.join(root, "tmp");
  const calls = path.join(root, "lima.calls");
  const limaEnvironment = path.join(root, "lima.environment");
  const state = path.join(root, "lima.state");
  const stopped = path.join(root, "lima.stopped");
  const runnerReceipt = path.join(root, "runner.env");
  const runnerAlive = path.join(root, "runner.alive");
  const runnerChildPid = path.join(root, "runner-child.pid");
  const runnerChildReady = path.join(root, "runner-child.ready");
  const runnerChildStopped = path.join(root, "runner-child.stopped");
  const runnerDriver = path.join(root, "runner-driver.mjs");
  const lifecycle = path.join(root, "lifecycle.log");
  const commandRootFailureMarker = path.join(root, "fail-command-root");
  const ownedCalls = path.join(root, "owned.calls");
  const pnpmCalls = path.join(root, "pnpm.calls");
  const sshCalls = path.join(root, "ssh.calls");
  const scpCalls = path.join(root, "scp.calls");
  const qaLogAtRunner = path.join(root, "qa-log-at-runner");
  const guestReady = path.join(root, "guest.ready");
  const remoteMarker = path.join(root, "remote.marker");
  fs.mkdirSync(path.join(qa, "fake-provider"), { recursive: true });
  fs.mkdirSync(path.join(qa, "lib"), { recursive: true });
  fs.mkdirSync(bin);
  fs.mkdirSync(tmp);
  if (staleQaLog) {
    fs.writeFileSync(path.join(repository, "qa.log"), "stale-project\n");
  }
  fs.copyFileSync(wrapperSource, path.join(qa, path.basename(wrapperSource)));
  fs.copyFileSync(
    guestSetupSource,
    path.join(qa, path.basename(guestSetupSource)),
  );
  for (const name of [
    "hmux-tuf-conformance-lima.yaml",
    "spawn-prompt-ssh-home-setup.mjs",
    "spawn-prompt-receipt-loss-client.mjs",
  ]) {
    fs.writeFileSync(path.join(qa, name), "fixture\n");
  }
  for (const name of ["claude", "dure-qa-fake-provider-common.sh"]) {
    fs.writeFileSync(path.join(qa, "fake-provider", name), "fixture\n");
  }
  fs.writeFileSync(
    runnerDriver,
    `import { spawn } from "node:child_process";
import fs from "node:fs";

const completion = '{"cleanup":"verified","schema":"dure-qa-tauri-app-runner/v1"}\\n';
const publishCompletion = () => {
  if (process.env.FAKE_RUNNER_CLEANUP_FAILURE === "1") process.exit(91);
  if (process.env.FAKE_COMMAND_ROOT_FAILURE_AFTER_RUNNER === "1") {
    fs.writeFileSync(process.env.FAKE_COMMAND_ROOT_FAILURE_MARKER, "fail\\n", {
      flag: "wx",
      mode: 0o600,
    });
  }
  fs.writeFileSync(process.env.DURE_QA_RUNNER_COMPLETION_RECEIPT, completion, {
    flag: "wx",
    mode: 0o600,
  });
  fs.appendFileSync(process.env.FAKE_LIFECYCLE, "runner-cleanup-receipt\\n");
};

if (process.env.FAKE_RUNNER_HUP !== "1") {
  publishCompletion();
  process.exit(0);
}

fs.writeFileSync(process.env.FAKE_RUNNER_ALIVE, "alive\\n");
const child = spawn(
  process.execPath,
  [
    "-e",
    'const fs=require("node:fs");const stopped=process.argv[1];const ready=process.argv[2];process.on("SIGTERM",()=>{fs.writeFileSync(stopped,"stopped\\\\n");process.exit(0)});fs.writeFileSync(ready,"ready\\\\n");setTimeout(()=>process.exit(90),15000);setInterval(()=>{},1000)',
    process.env.FAKE_RUNNER_CHILD_STOPPED,
    process.env.FAKE_RUNNER_CHILD_READY,
    process.env.FAKE_RUNNER_CHILD_PID,
  ],
  { detached: true, stdio: "ignore" },
);
fs.writeFileSync(process.env.FAKE_RUNNER_CHILD_PID, String(child.pid));
const readyMonitor = setInterval(() => {
  if (!fs.existsSync(process.env.FAKE_RUNNER_CHILD_READY)) return;
  clearInterval(readyMonitor);
  process.kill(process.ppid, "SIGHUP");
  const cancelMonitor = setInterval(() => {
    if (!fs.existsSync(process.env.DURE_QA_RUNNER_CANCEL_FILE)) return;
    clearInterval(cancelMonitor);
    process.kill(process.ppid, "SIGHUP");
    child.kill("SIGTERM");
    child.once("close", () => {
      fs.rmSync(process.env.FAKE_RUNNER_ALIVE, { force: true });
      publishCompletion();
      process.exit(129);
    });
  }, 10);
}, 10);
`,
  );
  executable(
    path.join(qa, "lib", "tauri-app-runner.sh"),
    `#!/bin/sh
set -eu
if [ -f qa.log ]; then
  cat qa.log >"$FAKE_QA_LOG_AT_RUNNER"
else
  printf '%s\n' missing >"$FAKE_QA_LOG_AT_RUNNER"
fi
printf '%s\n' \
  "$DURE_QA_PROJECT_KIND" \
  "$DURE_QA_PROJECT" \
  "$DURE_QA_SSH_HOST" \
  "$DURE_QA_SSH_USER" \
  "$DURE_QA_SSH_KEY_SOURCE" \
  "$DURE_QA_SSH_KNOWN_HOSTS_SOURCE" \
  "$DURE_QA_PROVIDER_INPUTS_LIMA_VM" \
  "$DURE_QA_PROVIDER_INPUTS_REMOTE_ROOT" \
  "$DURE_QA_PROVIDER_INPUTS_LIMA_HOME" \
  "$DURE_QA_HOME_SETUP" \
  "$DURE_QA_PROMPT" \
  "$DURE_QA_FAIL_PROMPT_SUCCESS_APPEND_ONCE" >"$FAKE_RUNNER_RECEIPT"
exec "$FAKE_NODE" "$FAKE_RUNNER_DRIVER"
`,
  );
  executable(
    path.join(qa, "lib", "bounded-owned-process-group.mjs"),
    `#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const operation = args.shift();
const controlRoot = args.shift();
const timeoutOption = args.shift();
const timeout = Number(args.shift()) * 1_000;
if (
  operation !== "run" ||
  !controlRoot ||
  timeoutOption !== "--timeout-seconds" ||
  args.shift() !== "--"
) {
  process.exit(97);
}
const command = args.shift();
const descriptor = path.join(controlRoot, "group.json");
const cancelFile = path.join(controlRoot, "cancel");
const completionReceipt = path.join(controlRoot, "completion.json");
fs.appendFileSync(
  process.env.FAKE_OWNED_CALLS,
  JSON.stringify([operation, controlRoot, timeout, command, ...args]) + "\\n",
);
if (process.env.FAKE_OWNED_FAILURE_COMMAND === command) process.exit(97);
fs.writeFileSync(descriptor, "fixture\\n");
let cancelMonitor;
let timeoutTimer;
const complete = (status) => {
  clearInterval(cancelMonitor);
  clearTimeout(timeoutTimer);
  fs.rmSync(descriptor, { force: true });
  fs.writeFileSync(
    completionReceipt,
    '{"cleanup":"verified","schema":"dure-qa-bounded-owned-process-group/v1"}\\n',
  );
  process.exit(status);
};
if (cancelFile && fs.existsSync(cancelFile)) complete(143);
let cancelled = false;
let timedOut = false;
const child = spawn(command, args, {
  env: {
    ...process.env,
    DURE_QA_LIVENESS_WITNESS_FD: "3",
    HEBBIAN_QA_LIVENESS_WITNESS_FD: "3",
  },
  stdio: ["inherit", "inherit", "inherit", "pipe"],
});
child.stdio[3].resume();
cancelMonitor = setInterval(() => {
  if (!cancelled && cancelFile && fs.existsSync(cancelFile)) {
    cancelled = true;
    child.kill("SIGTERM");
  }
}, 10);
timeoutTimer = timeout === undefined ? undefined : setTimeout(() => {
  timedOut = true;
  child.kill("SIGTERM");
}, timeout);
child.once("error", () => complete(126));
child.once("close", (status, signal) => {
  complete(cancelled ? 143 : timedOut ? 124 : signal ? 128 : (status ?? 1));
});
`,
  );
  executable(
    path.join(bin, "mktemp"),
    `#!/bin/sh
set -eu
last=
for argument in "$@"; do last=$argument; done
case "$last" in
  *dure-owned-command.*)
    if [ -f "$FAKE_COMMAND_ROOT_FAILURE_MARKER" ]; then
      rm -f "$FAKE_COMMAND_ROOT_FAILURE_MARKER"
      printf '%s\n' command-root-allocation-failed >>"$FAKE_LIFECYCLE"
      exit 71
    fi
    ;;
esac
exec /usr/bin/mktemp "$@"
`,
  );
  executable(
    path.join(bin, "uname"),
    `#!/bin/sh
case "\${1:-}" in
  -s) printf '%s\n' Darwin ;;
  -m) printf '%s\n' arm64 ;;
  *) exit 2 ;;
esac
`,
  );
  executable(
    path.join(bin, "pnpm"),
    `#!/bin/sh
printf '%s\n' "$*" >>"$FAKE_PNPM_CALLS"
`,
  );
  executable(
    path.join(bin, "limactl"),
    `#!/bin/sh
set -eu
printf '%s\n' "$*" >>"$FAKE_LIMA_CALLS"
printf '%s|%s|%s\n' "$*" "$HOME" "\${LIMA_HOME:-}" >>"$FAKE_LIMA_ENVIRONMENT"
printf 'lima-%s\n' "\${1:-unknown}" >>"$FAKE_LIFECYCLE"
case "\${1:-}" in
  --version)
    printf '%s\n' 'limactl version 1.2.1'
    ;;
  list)
    [ "\${FAKE_LIST_FAILURE:-0}" != 1 ] || exit 43
    [ ! -s "$FAKE_LIMA_STATE" ] || cat "$FAKE_LIMA_STATE"
    ;;
  start)
    if [ "\${FAKE_START_WITNESS_MUST_BE_CLOSED:-0}" = 1 ] &&
      (: >&3) 2>/dev/null; then
      exit 88
    fi
    shift
    instance=
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --name) instance=$2; shift 2 ;;
        --name=*) instance=\${1#--name=}; shift ;;
        *) shift ;;
      esac
    done
    if [ "\${FAKE_START_PATH_MUST_FIT:-0}" = 1 ]; then
      socket_path="$LIMA_HOME/$instance/ssh.sock.1234567890123456"
      [ "\${#socket_path}" -lt 104 ] || exit 89
    fi
    printf '%s\n' "$instance" >"$FAKE_LIMA_STATE"
    rm -f "$FAKE_LIMA_STOPPED"
    [ "\${FAKE_START_FAILURE:-0}" != 1 ] || exit 42
    ;;
  stop)
    : >"$FAKE_LIMA_STOPPED"
    ;;
  delete)
    if [ "\${FAKE_STICKY_DELETE:-0}" != 1 ]; then
      : >"$FAKE_LIMA_STATE"
      rm -f "$FAKE_LIMA_STOPPED"
    fi
    ;;
  copy)
    shift
    recursive=0
    if [ "\${1:-}" = --recursive ]; then
      recursive=1
      shift
    fi
    source_path=\${1:-}
    destination_path=\${2:-}
    case "$source_path" in
      *:*)
        [ "$recursive" -eq 1 ] || exit 47
        [ -s "$FAKE_LIMA_STATE" ] || exit 48
        [ ! -f "$FAKE_LIMA_STOPPED" ] || exit 49
        [ -f "$FAKE_GUEST_READY" ] || exit 44
        mkdir -p "$destination_path"
        printf '%s\n' guest-evidence >"$destination_path/exported"
        ;;
    esac
    ;;
  shell)
    shift
    [ "\${1:-}" != --tty=false ] || shift
    shift
    case "$*" in
      'id -un') printf '%s\n' dure ;;
      'sudo cat /etc/ssh/ssh_host_ed25519_key.pub')
        printf '%s fixture-host\n' "$FAKE_HOST_KEY"
        ;;
      'ip -j -4 address show scope global')
        printf '%s\n' \
          '[{"ifname":"lima0","addr_info":[{"family":"inet","local":"192.0.2.10","scope":"global"}]}]'
        ;;
      'cat /tmp/dure-spawn-prompt-ssh.fixture/transport-marker')
        [ -f "$FAKE_REMOTE_MARKER" ] || exit 45
        cat "$FAKE_REMOTE_MARKER"
        ;;
      *'/incoming/guest-setup.sh /tmp/dure-spawn-prompt-ssh.fixture')
        : >"$FAKE_GUEST_READY"
        ;;
      *) ;;
    esac
    ;;
  *) exit 91 ;;
esac
`,
  );
  executable(
    path.join(bin, "ssh-keygen"),
    `#!/bin/sh
set -eu
destination=
previous=
for argument in "$@"; do
  if [ "$previous" = -f ]; then destination=$argument; break; fi
  previous=$argument
done
[ -n "$destination" ] || exit 2
printf '%s\n' fixture-private-key >"$destination"
printf '%s\n' 'ssh-ed25519 AAAAclient dure-ssh-receipt-loss' >"$destination.pub"
`,
  );
  executable(
    path.join(bin, "ssh-keyscan"),
    `#!/bin/sh
host=
for argument in "$@"; do host=$argument; done
if [ "\${FAKE_HOST_KEY_MISMATCH:-0}" = 1 ]; then
  printf '%s %s\n' "$host" 'ssh-ed25519 AAAAmismatch'
else
  printf '%s %s\n' "$host" "$FAKE_HOST_KEY"
fi
`,
  );
  executable(
    path.join(bin, "ssh"),
    `#!/bin/sh
printf '%s\n' "$*" >>"$FAKE_SSH_CALLS"
case " $* " in *' -O exit '*) exit 0 ;; esac
[ "\${FAKE_SSH_HANG:-0}" != 1 ] || while :; do /bin/sleep 1; done
[ "\${FAKE_SSH_STATUS_97:-0}" != 1 ] || exit 97
`,
  );
  executable(
    path.join(bin, "scp"),
    `#!/bin/sh
previous=
last=
for argument in "$@"; do
  previous=$last
  last=$argument
done
printf '%s\n' "$*" >>"$FAKE_SCP_CALLS"
[ "\${FAKE_SCP_HANG:-0}" != 1 ] || {
  trap 'exit 143' HUP INT TERM
  while :; do /bin/sleep 1; done
}
[ -f "$previous" ] || exit 46
cat "$previous" >"$FAKE_REMOTE_MARKER"
`,
  );
  executable(path.join(bin, "sleep"), "#!/bin/sh\nexit 0\n");

  const startedAt = Date.now();
  const result = spawnSync(
    "sh",
    [path.join(qa, "spawn-prompt-ssh-receipt-loss-smoke.sh")],
    {
      cwd: repository,
      encoding: "utf8",
      killSignal: "SIGTERM",
      timeout: 30_000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        TMPDIR: tmp,
        DURE_QA_SSH_COMMAND_TIMEOUT_SECONDS: "0.5",
        DURE_QA_APP_TIMEOUT_SECONDS: "20",
        FAKE_COMMAND_ROOT_FAILURE_AFTER_RUNNER:
          commandRootFailureAfterRunner ? "1" : "0",
        FAKE_COMMAND_ROOT_FAILURE_MARKER: commandRootFailureMarker,
        FAKE_GUEST_READY: guestReady,
        FAKE_HOST_KEY: "ssh-ed25519 AAAAcontrol",
        FAKE_HOST_KEY_MISMATCH: hostKeyMismatch ? "1" : "0",
        FAKE_LIMA_CALLS: calls,
        FAKE_LIMA_ENVIRONMENT: limaEnvironment,
        FAKE_LIST_FAILURE: listFailure ? "1" : "0",
        FAKE_LIFECYCLE: lifecycle,
        FAKE_LIMA_STATE: state,
        FAKE_LIMA_STOPPED: stopped,
        FAKE_OWNED_FAILURE_COMMAND: ownedFailure ? "ssh" : "",
        FAKE_OWNED_CALLS: ownedCalls,
        FAKE_NODE: process.execPath,
        FAKE_PNPM_CALLS: pnpmCalls,
        FAKE_QA_LOG_AT_RUNNER: qaLogAtRunner,
        FAKE_REMOTE_MARKER: remoteMarker,
        FAKE_RUNNER_RECEIPT: runnerReceipt,
        FAKE_RUNNER_ALIVE: runnerAlive,
        FAKE_RUNNER_CHILD_PID: runnerChildPid,
        FAKE_RUNNER_CHILD_READY: runnerChildReady,
        FAKE_RUNNER_CHILD_STOPPED: runnerChildStopped,
        FAKE_RUNNER_CLEANUP_FAILURE: runnerCleanupFailure ? "1" : "0",
        FAKE_RUNNER_DRIVER: runnerDriver,
        FAKE_RUNNER_HUP: wrapperHup ? "1" : "0",
        FAKE_SCP_CALLS: scpCalls,
        FAKE_SCP_HANG: scpHang ? "1" : "0",
        FAKE_SSH_CALLS: sshCalls,
        FAKE_SSH_HANG: sshHang ? "1" : "0",
        FAKE_SSH_STATUS_97: sshStatus97 ? "1" : "0",
        FAKE_START_FAILURE: startFailure ? "1" : "0",
        FAKE_START_PATH_MUST_FIT: startPathMustFit ? "1" : "0",
        FAKE_START_WITNESS_MUST_BE_CLOSED:
          startWitnessMustBeClosed ? "1" : "0",
        FAKE_STICKY_DELETE: stickyDelete ? "1" : "0",
      },
    },
  );
  const lines = (file) =>
    fs.existsSync(file)
      ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean)
      : [];
  const observedLimaEnvironment = lines(limaEnvironment);
  const limaHome = observedLimaEnvironment
    .map((line) => line.split("|").at(-1))
    .find((candidate) => candidate?.endsWith("/lima"));
  const fixtureRoot = limaHome ? path.dirname(limaHome) : undefined;
  if (fixtureRoot) fixtureRoots.push(fixtureRoot);
  return {
    calls: lines(calls),
    lifecycle: lines(lifecycle),
    fixtureRoot,
    limaEnvironment: observedLimaEnvironment,
    limaHome,
    ownedCalls: lines(ownedCalls).map((line) => JSON.parse(line)),
    pnpmCalls: lines(pnpmCalls),
    qaLogAtRunner: lines(qaLogAtRunner),
    preserved:
      fixtureRoot && fs.existsSync(fixtureRoot)
        ? [path.basename(fixtureRoot)]
        : [],
    result,
    root,
    runnerAlive: fs.existsSync(runnerAlive),
    runnerChildPid: Number(lines(runnerChildPid)[0] ?? 0),
    runnerChildStopped: fs.existsSync(runnerChildStopped),
    runtimeMs: Date.now() - startedAt,
    runner: lines(runnerReceipt),
    scpCalls: lines(scpCalls),
    sshCalls: lines(sshCalls),
    state: lines(state),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    stopLeakedRunnerChild(root);
    fs.rmSync(root, { force: true, recursive: true });
  }
  for (const fixtureRoot of fixtureRoots.splice(0)) {
    if (
      path.dirname(fixtureRoot) === "/tmp" &&
      path.basename(fixtureRoot).startsWith("dure-spawn-prompt-ssh.")
    ) {
      fs.rmSync(fixtureRoot, { force: true, recursive: true });
    }
  }
});

describe("spawn prompt SSH receipt-loss wrapper", () => {
  test("owns one vzNAT VM and composes the existing app runner", () => {
    const observed = fixture({
      startPathMustFit: true,
      startWitnessMustBeClosed: true,
    });

    expect(observed.result.status, observed.result.stderr).toBe(0);
    expect(observed.pnpmCalls).toEqual(["hmux:remote:stage:dev"]);
    expect(observed.ownedCalls.every((call) => call[0] === "run")).toBe(true);
    expect(
      observed.ownedCalls.some((call) =>
        call.some((argument) => argument.endsWith?.("/tauri-app-runner.sh")),
      ),
    ).toBe(false);
    expect(
      observed.ownedCalls.some((call) =>
        call[2] === 630_000 &&
        call[3] === "env" &&
        call.includes("limactl") &&
        call.includes("start"),
      ),
    ).toBe(true);
    const starts = observed.calls.filter((call) => call.startsWith("start "));
    expect(starts).toHaveLength(1);
    expect(starts[0]).toContain("--network=vzNAT");
    expect(starts[0]).toContain("--cpus 2 --memory 2");
    const startEnvironment = observed.limaEnvironment.find((line) =>
      line.startsWith("start "),
    );
    expect(startEnvironment).toMatch(
      /\|[^|]+\/dure-spawn-prompt-ssh\.[^/]+\/host-home\|[^|]+\/dure-spawn-prompt-ssh\.[^/]+\/lima$/u,
    );
    expect(
      Buffer.byteLength(
        `${observed.limaHome}/dure-ssh-receipt-loss/ssh.sock.1234567890123456`,
      ),
    ).toBeLessThan(104);
    expect(observed.runner[0]).toBe("ssh");
    expect(observed.runner[1]).toBe(
      "/tmp/dure-spawn-prompt-ssh.fixture/project",
    );
    expect(observed.runner[2]).toBe("192.0.2.10");
    expect(observed.runner[3]).toBe("dure");
    expect(observed.runner[6]).toBe("dure-ssh-receipt-loss");
    expect(observed.runner[7]).toBe(
      "/tmp/dure-spawn-prompt-ssh.fixture/provider-capture",
    );
    expect(observed.runner[8]).toContain("/dure-spawn-prompt-ssh.");
    expect(observed.runner[9]).toContain(
      "/scripts/qa/spawn-prompt-ssh-home-setup.mjs",
    );
    expect(observed.runner[10]).toMatch(
      /^ssh-receipt-loss-[0-9]+-one-shot$/u,
    );
    expect(observed.runner[11]).toBe(
      `sha256:${crypto.createHash("sha256").update(observed.runner[10]).digest("hex")}`,
    );
    const controlMasterExits = observed.sshCalls.filter((call) =>
      call.includes("-O exit"),
    );
    expect(controlMasterExits).toHaveLength(1);
    expect(controlMasterExits[0]).toContain(
      "/lima/dure-ssh-receipt-loss/ssh.sock",
    );
    const directSshCalls = observed.sshCalls.filter(
      (call) => !call.includes("-O exit"),
    );
    expect(directSshCalls).toHaveLength(1);
    expect(directSshCalls[0]).toContain("StrictHostKeyChecking=yes");
    expect(directSshCalls[0]).toContain("IdentitiesOnly=yes");
    expect(observed.scpCalls).toHaveLength(1);
    expect(observed.scpCalls[0]).toContain("-O -F /dev/null");
    const evidenceCopyIndex = observed.calls.findIndex((call) =>
      call.startsWith(
        "copy --recursive dure-ssh-receipt-loss:/tmp/dure-spawn-prompt-ssh.fixture ",
      ),
    );
    const deleteIndex = observed.calls.indexOf(
      "delete --force dure-ssh-receipt-loss",
    );
    const stopIndex = observed.calls.indexOf(
      "stop --force dure-ssh-receipt-loss",
    );
    expect(evidenceCopyIndex).toBeGreaterThan(-1);
    expect(stopIndex).toBeGreaterThan(evidenceCopyIndex);
    expect(deleteIndex).toBeGreaterThan(stopIndex);
    expect(stopIndex).toBeGreaterThan(-1);
    expect(deleteIndex).toBeGreaterThan(-1);
    const runnerCleanupIndex = observed.lifecycle.indexOf(
      "runner-cleanup-receipt",
    );
    expect(runnerCleanupIndex).toBeGreaterThan(-1);
    expect(observed.lifecycle.lastIndexOf("lima-stop")).toBeGreaterThan(
      runnerCleanupIndex,
    );
    expect(observed.lifecycle.lastIndexOf("lima-delete")).toBeGreaterThan(
      runnerCleanupIndex,
    );
    expect(observed.state).toEqual([]);
    expect(observed.preserved).toEqual([]);
  });

  test("starts the app with no project records from an earlier QA run", () => {
    const observed = fixture({ staleQaLog: true });

    expect(observed.result.status, observed.result.stderr).toBe(0);
    expect(observed.qaLogAtRunner).toEqual(["missing"]);
  });

  test("does not launch the app when direct SSH presents a different host key", () => {
    const observed = fixture({ hostKeyMismatch: true });

    expect(observed.result.status).not.toBe(0);
    expect(observed.result.stderr).toContain(
      "direct SSH host key did not match the Lima control plane",
    );
    expect(observed.runner).toEqual([]);
    expect(observed.state).toEqual([]);
    expect(observed.preserved).toHaveLength(1);
  });

  test("stops a hung direct SSH proof and exports guest evidence", () => {
    const observed = fixture({ sshHang: true });

    expect(observed.result.status).not.toBe(0);
    expect(observed.result.stderr).toContain("bounded ssh timed out");
    expect(observed.runner).toEqual([]);
    expect(observed.state).toEqual([]);
    expect(observed.preserved).toHaveLength(1);
    expect(
      fs.existsSync(
        path.join(observed.fixtureRoot, "guest-evidence", "exported"),
      ),
    ).toBe(true);
  });

  test("stops a hung SCP proof before launching the app", () => {
    const observed = fixture({ scpHang: true });

    expect(observed.result.status).not.toBe(0);
    expect(observed.result.stderr).toContain("bounded scp timed out");
    expect(observed.runner).toEqual([]);
    expect(observed.state).toEqual([]);
    expect(observed.preserved).toHaveLength(1);
  });

  test("runs VM cleanup after a wrapper-only HUP", () => {
    const observed = fixture({ wrapperHup: true });

    expect(observed.result.status, observed.result.stderr).toBe(129);
    expect(observed.runner[0]).toBe("ssh");
    expect(observed.runnerAlive).toBe(false);
    expect(observed.runnerChildPid).toBeGreaterThan(1);
    expect(observed.runnerChildStopped).toBe(true);
    expect(processExists(observed.runnerChildPid)).toBe(false);
    expect(observed.runtimeMs).toBeLessThan(8_000);
    expect(observed.state).toEqual([]);
    expect(observed.preserved).toHaveLength(1);
    expect(observed.calls).toContain("stop --force dure-ssh-receipt-loss");
    expect(observed.calls).toContain("delete --force dure-ssh-receipt-loss");
  });

  test("preserves the VM when the app runner cannot prove cleanup", () => {
    const observed = fixture({ runnerCleanupFailure: true });

    expect(observed.result.status).not.toBe(0);
    expect(observed.result.stderr).toContain("app runner cleanup is uncertain");
    expect(observed.state).toEqual(["dure-ssh-receipt-loss"]);
    expect(observed.preserved).toHaveLength(1);
    expect(observed.calls).not.toContain("stop --force dure-ssh-receipt-loss");
    expect(observed.calls).not.toContain("delete --force dure-ssh-receipt-loss");
  });

  test("does not derive control paths when cleanup temp allocation fails", () => {
    const observed = fixture({ commandRootFailureAfterRunner: true });

    expect(observed.result.status).not.toBe(0);
    expect(observed.lifecycle).toContain("command-root-allocation-failed");
    expect(observed.result.stderr).toContain(
      "could not allocate a private dure-owned-command root",
    );
    expect(observed.result.stderr).not.toContain("descriptor=/group.json");
    expect(observed.state).toEqual(["dure-ssh-receipt-loss"]);
    expect(observed.preserved).toHaveLength(1);
    expect(observed.calls).not.toContain("stop --force dure-ssh-receipt-loss");
    expect(observed.calls).not.toContain("delete --force dure-ssh-receipt-loss");
  });

  test("does not mutate the VM after exact leaf cleanup becomes uncertain", () => {
    const observed = fixture({ ownedFailure: true });

    expect(observed.result.status).not.toBe(0);
    expect(observed.result.stderr).toContain("exact cleanup is uncertain");
    expect(observed.result.stderr).toMatch(
      /command_root=\S+\/dure-owned-command\.\S+ descriptor=\S+\/group\.json receipt=\S+\/completion\.json/u,
    );
    expect(observed.runner).toEqual([]);
    expect(observed.state).toEqual(["dure-ssh-receipt-loss"]);
    expect(observed.preserved).toHaveLength(1);
    expect(observed.calls).not.toContain("stop --force dure-ssh-receipt-loss");
    expect(observed.calls).not.toContain("delete --force dure-ssh-receipt-loss");
  });

  test("does not confuse a cleaned child status 97 with cleanup uncertainty", () => {
    const observed = fixture({ sshStatus97: true });

    expect(observed.result.status).toBe(97);
    expect(observed.result.stderr).not.toContain("exact cleanup is uncertain");
    expect(observed.state).toEqual([]);
    expect(observed.preserved).toHaveLength(1);
    expect(observed.calls).toContain("stop --force dure-ssh-receipt-loss");
    expect(observed.calls).toContain("delete --force dure-ssh-receipt-loss");
  });

  test("does not start when the isolated Lima census fails", () => {
    const observed = fixture({ listFailure: true });

    expect(observed.result.status).not.toBe(0);
    expect(observed.result.stderr).toContain(
      "could not inspect the isolated Lima home",
    );
    expect(observed.calls.some((call) => call.startsWith("start "))).toBe(
      false,
    );
    expect(observed.runner).toEqual([]);
    expect(observed.preserved).toHaveLength(1);
  });

  test("cleans a partially created VM when start reports failure", () => {
    const observed = fixture({ startFailure: true });

    expect(observed.result.status).not.toBe(0);
    expect(observed.runner).toEqual([]);
    expect(observed.state).toEqual([]);
    expect(observed.calls).toContain("delete --force dure-ssh-receipt-loss");
    expect(observed.preserved).toHaveLength(1);
  });

  test("preserves the exact fixture when VM absence cannot be proven", () => {
    const observed = fixture({ stickyDelete: true });

    expect(observed.result.status).not.toBe(0);
    expect(observed.runner[0]).toBe("ssh");
    expect(observed.state).toEqual(["dure-ssh-receipt-loss"]);
    expect(observed.preserved).toHaveLength(1);
    expect(observed.result.stderr).toContain("preserving fixture root=");
  });
});
