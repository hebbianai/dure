import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const soakScript = path.join(
  repositoryRoot,
  "scripts/qa/hmux-remote-soak.sh",
);
const temporaryRoots = new Set();
const ownedChildren = new Set();
const ownedProcessGroups = new Set();
const orphanedProcessGroups = new Set();

// Every behavioral case crosses three real process boundaries (soak, timeout,
// and SSH) and performs exact process-exit observation. Keep that work out of
// Vitest's 5s unit budget without relaxing the repository-wide default.
const REMOTE_SOAK_FIXTURE_TIMEOUT_MS = 20_000;
const REMOTE_SOAK_KILL_GRACE_TEST_TIMEOUT_MS = 14_000;

function executable(file, body) {
  fs.writeFileSync(file, body, { mode: 0o755 });
}

function fixture() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "hmux-remote-soak-test."),
  );
  temporaryRoots.add(root);
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const state = path.join(root, "state");
  const defaultDiscovery = path.join(home, "default-discovery");
  fs.mkdirSync(path.join(home, ".local/bin"), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(defaultDiscovery, { recursive: true });
  const sentinel = path.join(defaultDiscovery, "sentinel");
  fs.writeFileSync(sentinel, "must-stay-byte-identical\n");

  const log = path.join(state, "hmux.log");
  const lifecycle = path.join(state, "lifecycle");
  const pidFile = path.join(state, "host.pid");
  const markerFile = path.join(state, "marker");
  const sequenceFile = path.join(state, "sequence");
  const listCountFile = path.join(state, "list-count");
  fs.writeFileSync(lifecycle, "empty\n");
  fs.writeFileSync(sequenceFile, "0\n");
  fs.writeFileSync(listCountFile, "0\n");
  const host = spawn(process.execPath, [
    "-e",
    "setInterval(() => {}, 300_000)",
  ]);
  const provider = spawn(process.execPath, [
    "-e",
    "setInterval(() => {}, 300_000)",
  ]);
  ownedChildren.add(host);
  ownedChildren.add(provider);

  const fakeHmux = path.join(home, ".local/bin/hmux");
  executable(
    fakeHmux,
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >>"$FAKE_HMUX_LOG"
if [ "\${1:-}" != "--discovery-root" ] || [ -z "\${2:-}" ]; then
  echo "fixture hmux: discovery root was not explicit" >&2
  exit 91
fi
discovery_root=$2
shift 2
if [ "\${1:-}" = "--json" ]; then
  shift
fi
command=\${1:-}
test -n "$command"
shift

case "$command" in
  capabilities)
    if [ "\${FAKE_HMUX_MISSING_FENCED_KILL:-0}" = "1" ]; then
      printf '{"capabilities":[]}\\n'
    else
      printf '{"capabilities":["generation_fenced_kill_v1"]}\\n'
    fi
    ;;
  ls)
    list_count=$(( $(cat "$FAKE_HMUX_LIST_COUNT_FILE") + 1 ))
    printf '%s\\n' "$list_count" >"$FAKE_HMUX_LIST_COUNT_FILE"
    lifecycle=$(cat "$FAKE_HMUX_LIFECYCLE")
    if [ "$lifecycle" = "ready" ] &&
      [ -n "\${FAKE_HMUX_EXIT_AFTER_LS:-}" ] &&
      [ "$list_count" -ge "$FAKE_HMUX_EXIT_AFTER_LS" ]; then
      lifecycle=exited
      printf 'exited\\n' >"$FAKE_HMUX_LIFECYCLE"
    fi
    if [ "$lifecycle" = "ready" ] || [ "$lifecycle" = "exited" ]; then
      host_pid=$(cat "$FAKE_HMUX_PID_FILE")
      terminal_epoch=terminal-epoch-fixture
      if [ -n "\${FAKE_HMUX_REPLACE_AFTER_LS:-}" ] &&
        [ "$list_count" -ge "$FAKE_HMUX_REPLACE_AFTER_LS" ]; then
        terminal_epoch=terminal-epoch-replacement
      fi
      printf '[{"session_id":"session-fixture","session_name":"%s","workspace_id":"workspace-fixture","runner_principal":"runner-principal-fixture","runner_instance":"runner-instance-fixture","channel_epoch":"1","host_instance_id":"host-instance-fixture","terminal_epoch":"%s","lifecycle":"%s","host_process":{"process_id":%s,"start_marker":"fixture-host-start"},"provider_process":{"process_id":%s,"start_marker":"fixture-provider-start"}}]\\n' \
        "$(cat "$FAKE_HMUX_NAME_FILE")" "$terminal_epoch" "$lifecycle" "$host_pid" "$FAKE_HMUX_PROVIDER_PID"
    else
      printf '[]\\n'
    fi
    ;;
  new)
    if [ "\${FAKE_HMUX_CREATE_FAIL:-0}" = "1" ]; then
      echo "fixture create failure" >&2
      exit 92
    fi
    mkdir -p "$discovery_root"
    name=
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--name" ]; then
        name=$2
        shift 2
      else
        shift
      fi
    done
    test -n "$name"
    printf '%s\\n' "$name" >"$FAKE_HMUX_NAME_FILE"
    host_pid=$FAKE_HMUX_HOST_PID
    kill -0 "$host_pid"
    kill -0 "$FAKE_HMUX_PROVIDER_PID"
    printf '%s\\n' "$host_pid" >"$FAKE_HMUX_PID_FILE"
    printf 'ready\\n' >"$FAKE_HMUX_LIFECYCLE"
    printf '{"sessionId":"session-fixture"}\\n'
    ;;
  send-keys)
    marker=$(printf '%s\\n' "$*" |
      sed -n 's/.*\\(HMUX_SOAK_[A-Z]*_session-fixture\\).*/\\1/p')
    if [ -n "$marker" ]; then
      printf '%s\\n' "$marker" >"$FAKE_HMUX_MARKER_FILE"
    fi
    printf '{"ok":true,"state":"WrittenToPty"}\\n'
    ;;
  read)
    marker=$(cat "$FAKE_HMUX_MARKER_FILE")
    printf '{"ok":true,"lines":["%s"]}\\n' "$marker"
    ;;
  screen)
    if [ -n "\${FAKE_HMUX_SCREEN_DELAY_SECONDS:-}" ]; then
      sleep "$FAKE_HMUX_SCREEN_DELAY_SECONDS"
    fi
    sequence=$(( $(cat "$FAKE_HMUX_SEQUENCE_FILE") + 1 ))
    printf '%s\\n' "$sequence" >"$FAKE_HMUX_SEQUENCE_FILE"
    printf '{"ok":true,"truncated":false,"rows":24,"columns":80,"sequenceThrough":"%s"}\\n' "$sequence"
    ;;
  attach)
    echo "fixture hmux: attach must be owned by the timeout fixture" >&2
    exit 93
    ;;
  kill)
    target=\${1:-}
    shift
    test "$target" = "session-fixture"
    test "\${1:-}" = "--expected-fence-json"
    expected_fence=\${2:-}
    printf '%s' "$expected_fence" |
      jq -e '
        .workspace_id == "workspace-fixture"
        and .session_id == "session-fixture"
        and .runner_principal == "runner-principal-fixture"
        and .runner_instance == "runner-instance-fixture"
        and .channel_epoch == "1"
        and .host_instance_id == "host-instance-fixture"
        and .terminal_epoch == "terminal-epoch-fixture"
      ' >/dev/null
    if [ "\${FAKE_HMUX_REPLACE_ON_KILL:-0}" = "1" ]; then
      echo "fixture expected generation mismatch" >&2
      exit 97
    fi
    if [ "\${FAKE_HMUX_KILL_FAIL:-0}" = "1" ]; then
      echo "fixture kill failure" >&2
      exit 94
    fi
    if [ "$(cat "$FAKE_HMUX_LIFECYCLE")" = "exited" ] &&
      [ "\${FAKE_HMUX_EXITED_KILL_FAIL:-0}" = "1" ]; then
      echo "fixture incomplete exited cleanup" >&2
      exit 96
    fi
    if [ "$(cat "$FAKE_HMUX_LIFECYCLE")" = "ready" ]; then
      host_pid=$(cat "$FAKE_HMUX_PID_FILE")
      kill "$host_pid"
      kill "$FAKE_HMUX_PROVIDER_PID"
      attempt=0
      while {
        kill -0 "$host_pid" 2>/dev/null ||
          kill -0 "$FAKE_HMUX_PROVIDER_PID" 2>/dev/null
      } && [ "$attempt" -lt 100 ]; do
        attempt=$((attempt + 1))
        sleep 0.01
      done
    fi
    printf 'exited\\n' >"$FAKE_HMUX_LIFECYCLE"
    ;;
  *)
    echo "fixture hmux: unsupported command $command" >&2
    exit 95
    ;;
esac
`,
  );

  const fakeTimeout = path.join(bin, "timeout");
  executable(
    fakeTimeout,
    `#!/bin/sh
set -eu
if [ "\${1:-}" = "-k" ]; then
  case "\${2:-}" in
    1s | 15s) ;;
    *) echo "fixture timeout: unexpected KILL grace" >&2; exit 98 ;;
  esac
  shift 2
fi
shift
if printf ' %s ' "$*" | grep -F ' attach ' >/dev/null; then
  cat "$FAKE_HMUX_MARKER_FILE"
  exit 124
fi
if [ "\${FAKE_REMOTE_TIMEOUT:-0}" = "1" ]; then
  test "\${1:-}" = "sh"
  test "\${2:-}" = "-s"
  test "\${3:-}" = "--"
  remote_script=$(mktemp)
  cat >"$remote_script"
  sh "$remote_script" "\${4:-}" &
  remote_pid=$!
  attempt=0
  while [ ! -f "$FAKE_HMUX_PID_FILE" ] && [ "$attempt" -lt 100 ]; do
    attempt=$((attempt + 1))
    sleep 0.01
  done
  test -f "$FAKE_HMUX_PID_FILE"
  kill -TERM "$remote_pid"
  status=0
  wait "$remote_pid" || status=$?
  rm -f "$remote_script"
  exit "$status"
fi
exec "$@"
`,
  );

  const fakeSsh = path.join(bin, "ssh");
  executable(
    fakeSsh,
    `#!/bin/sh
set -eu
remote_command=
for argument in "$@"; do
  remote_command=$argument
done
test -n "$remote_command"
exec sh -c "$remote_command"
`,
  );

  return {
    root,
    home,
    bin,
    state,
    sentinel,
    defaultDiscovery,
    log,
    lifecycle,
    pidFile,
    markerFile,
    sequenceFile,
    listCountFile,
    fakeSsh,
    host,
    provider,
    nameFile: path.join(state, "name"),
  };
}

async function runSoak(lab, overrides = {}) {
  const child = spawn(soakScript, ["fixture.example"], {
    cwd: repositoryRoot,
    detached: true,
    env: {
      ...process.env,
      HOME: lab.home,
      PATH: `${lab.bin}:${process.env.PATH}`,
      HMUX_QA_SSH_PROGRAM: lab.fakeSsh,
      HMUX_REMOTE_SOAK_SCREEN_READS: "1",
      HMUX_REMOTE_SOAK_TIMEOUT_SECONDS: "30",
      FAKE_HMUX_LOG: lab.log,
      FAKE_HMUX_LIFECYCLE: lab.lifecycle,
      FAKE_HMUX_PID_FILE: lab.pidFile,
      FAKE_HMUX_MARKER_FILE: lab.markerFile,
      FAKE_HMUX_SEQUENCE_FILE: lab.sequenceFile,
      FAKE_HMUX_LIST_COUNT_FILE: lab.listCountFile,
      FAKE_HMUX_NAME_FILE: lab.nameFile,
      FAKE_HMUX_HOST_PID: String(lab.host.pid),
      FAKE_HMUX_PROVIDER_PID: String(lab.provider.pid),
      ...overrides,
    },
  });
  ownedChildren.add(child);
  ownedProcessGroups.add(child);
  let stdout = "";
  let stderr = "";
  let error;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.on("error", (spawnError) => {
    error = spawnError;
  });
  const [status] = await once(child, "close");
  const groupStopped = await waitForProcessGroupExit(child.pid, 1_000);
  ownedChildren.delete(child);
  ownedProcessGroups.delete(child);
  if (!groupStopped) {
    orphanedProcessGroups.add(child.pid);
    throw new Error("owned soak process group remained after its leader closed");
  }
  return { error, status, stderr, stdout };
}

function loggedDiscoveryRoot(lab) {
  const roots = fs
    .readFileSync(lab.log, "utf8")
    .trim()
    .split("\n")
    .map((line) => line.match(/--discovery-root ([^ ]+)/)?.[1])
    .filter(Boolean);
  expect(roots.length).toBeGreaterThan(0);
  expect(new Set(roots).size).toBe(1);
  return roots[0];
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

function signalOwnedChild(child, signal) {
  try {
    if (ownedProcessGroups.has(child)) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch (error) {
    if (error.code !== "ESRCH") {
      throw error;
    }
  }
}

function processGroupExists(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function waitForProcessGroupExit(processGroupId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(processGroupId)) {
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 25);
      timer.unref();
    });
  }
  return true;
}

afterEach(async () => {
  let cleanupFailure;
  for (const child of ownedChildren) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      signalOwnedChild(child, "SIGTERM");
      const stopped = await Promise.race([
        exited.then(() => true),
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve(false), 500);
          timer.unref();
        }),
      ]);
      if (!stopped) {
        if (child.exitCode === null && child.signalCode === null) {
          signalOwnedChild(child, "SIGKILL");
          const killed = await Promise.race([
            exited.then(() => true),
            new Promise((resolve) => {
              const timer = setTimeout(() => resolve(false), 2_000);
              timer.unref();
            }),
          ]);
          if (!killed) {
            cleanupFailure ??= new Error(
              `owned fixture process ${child.pid} survived SIGKILL`,
            );
          }
        } else if (processGroupExists(child.pid)) {
          cleanupFailure ??= new Error(
            `owned fixture process group ${child.pid} outlived its leader`,
          );
        }
      }
    }
    if (ownedProcessGroups.has(child)) {
      const groupStopped = await waitForProcessGroupExit(child.pid, 500);
      if (!groupStopped) {
        if (child.exitCode === null && child.signalCode === null) {
          signalOwnedChild(child, "SIGKILL");
          const killed = await waitForProcessGroupExit(child.pid, 2_000);
          if (!killed) {
            cleanupFailure ??= new Error(
              `owned fixture process group ${child.pid} survived SIGKILL`,
            );
          }
        } else {
          cleanupFailure ??= new Error(
            `owned fixture process group ${child.pid} outlived its leader`,
          );
        }
      }
      ownedProcessGroups.delete(child);
    }
  }
  ownedChildren.clear();
  if (orphanedProcessGroups.size > 0) {
    cleanupFailure ??= new Error(
      `owned fixture process groups outlived their leaders: ${[
        ...orphanedProcessGroups,
      ].join(",")}`,
    );
  }
  orphanedProcessGroups.clear();
  if (cleanupFailure) {
    throw cleanupFailure;
  }
  for (const root of temporaryRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  temporaryRoots.clear();
});

describe("hmux remote soak isolation and cleanup", () => {
  test(
    "uses one isolated root and proves the exact Host exited before success",
    async () => {
      const lab = fixture();
      const sentinelBefore = fs.readFileSync(lab.sentinel);
      const result = await runSoak(lab);

      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const receipt = JSON.parse(result.stdout);
      expect(receipt).toMatchObject({
        ok: true,
        hostStartMarker: "fixture-host-start",
        isolatedDiscovery: true,
        cleanup: true,
        screenReads: 3,
      });
      expect(fs.readFileSync(lab.sentinel)).toEqual(sentinelBefore);
      const discoveryRoot = loggedDiscoveryRoot(lab);
      expect(discoveryRoot).not.toContain(lab.defaultDiscovery);
      expect(fs.existsSync(path.dirname(discoveryRoot))).toBe(false);
      const hostPid = Number.parseInt(fs.readFileSync(lab.pidFile, "utf8"), 10);
      expect(processExists(hostPid)).toBe(false);
      expect(processExists(lab.provider.pid)).toBe(false);
      expect(fs.readFileSync(lab.log, "utf8")).toContain(
        `kill session-fixture`,
      );
    },
    REMOTE_SOAK_FIXTURE_TIMEOUT_MS,
  );

  test(
    "preserves the isolated evidence and fails when exact cleanup is refused",
    async () => {
      const lab = fixture();
      const sentinelBefore = fs.readFileSync(lab.sentinel);
      const result = await runSoak(lab, { FAKE_HMUX_KILL_FAIL: "1" });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("cleanup was not proven");
      expect(fs.readFileSync(lab.sentinel)).toEqual(sentinelBefore);
      const discoveryRoot = loggedDiscoveryRoot(lab);
      expect(fs.existsSync(path.dirname(discoveryRoot))).toBe(true);
      const hostPid = Number.parseInt(fs.readFileSync(lab.pidFile, "utf8"), 10);
      expect(processExists(hostPid)).toBe(true);
      expect(processExists(lab.provider.pid)).toBe(true);
    },
    REMOTE_SOAK_FIXTURE_TIMEOUT_MS,
  );

  test(
    "a create failure never kills anything and removes only its empty QA root",
    async () => {
      const lab = fixture();
      const sentinelBefore = fs.readFileSync(lab.sentinel);
      const result = await runSoak(lab, { FAKE_HMUX_CREATE_FAIL: "1" });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("fixture create failure");
      expect(fs.readFileSync(lab.sentinel)).toEqual(sentinelBefore);
      const log = fs.readFileSync(lab.log, "utf8");
      expect(log).not.toMatch(/(?:^| )kill(?: |$)/m);
      const discoveryRoot = loggedDiscoveryRoot(lab);
      expect(fs.existsSync(path.dirname(discoveryRoot))).toBe(false);
      expect(fs.existsSync(lab.pidFile)).toBe(false);
    },
    REMOTE_SOAK_FIXTURE_TIMEOUT_MS,
  );

  test(
    "an old CLI is refused before any session is created",
    async () => {
      const lab = fixture();
      const result = await runSoak(lab, {
        FAKE_HMUX_MISSING_FENCED_KILL: "1",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("lacks generation_fenced_kill_v1");
      const log = fs.readFileSync(lab.log, "utf8");
      expect(log).not.toMatch(/(?:^| )new(?: |$)/m);
      expect(log).not.toMatch(/(?:^| )kill(?: |$)/m);
      const discoveryRoot = loggedDiscoveryRoot(lab);
      expect(fs.existsSync(path.dirname(discoveryRoot))).toBe(false);
    },
    REMOTE_SOAK_FIXTURE_TIMEOUT_MS,
  );

  test(
    "refuses to kill a replacement full generation",
    async () => {
      const lab = fixture();
      const result = await runSoak(lab, {
        FAKE_HMUX_REPLACE_AFTER_LS: "3",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("cleanup was not proven");
      expect(fs.readFileSync(lab.log, "utf8")).not.toMatch(
        /(?:^| )kill(?: |$)/m,
      );
      const discoveryRoot = loggedDiscoveryRoot(lab);
      expect(fs.existsSync(path.dirname(discoveryRoot))).toBe(true);
      expect(processExists(lab.host.pid)).toBe(true);
      expect(processExists(lab.provider.pid)).toBe(true);
    },
    REMOTE_SOAK_FIXTURE_TIMEOUT_MS,
  );

  test(
    "the kill command itself refuses a replacement after the census",
    async () => {
      const lab = fixture();
      const result = await runSoak(lab, {
        FAKE_HMUX_REPLACE_ON_KILL: "1",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("cleanup was not proven");
      expect(fs.readFileSync(lab.log, "utf8")).toContain(
        "kill session-fixture --expected-fence-json",
      );
      const discoveryRoot = loggedDiscoveryRoot(lab);
      expect(fs.existsSync(path.dirname(discoveryRoot))).toBe(true);
      expect(processExists(lab.host.pid)).toBe(true);
      expect(processExists(lab.provider.pid)).toBe(true);
    },
    REMOTE_SOAK_FIXTURE_TIMEOUT_MS,
  );

  test(
    "an exited descriptor still must pass idempotent cleanup validation",
    async () => {
      const lab = fixture();
      const result = await runSoak(lab, {
        FAKE_HMUX_EXIT_AFTER_LS: "3",
        FAKE_HMUX_EXITED_KILL_FAIL: "1",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("cleanup was not proven");
      expect(fs.readFileSync(lab.log, "utf8")).toContain(
        "kill session-fixture",
      );
      const discoveryRoot = loggedDiscoveryRoot(lab);
      expect(fs.existsSync(path.dirname(discoveryRoot))).toBe(true);
      expect(processExists(lab.provider.pid)).toBe(true);
    },
    REMOTE_SOAK_FIXTURE_TIMEOUT_MS,
  );

  test(
    "a remote TERM finishes exact cleanup inside the KILL grace",
    async () => {
      const lab = fixture();
      const result = await runSoak(lab, {
        FAKE_REMOTE_TIMEOUT: "1",
        FAKE_HMUX_SCREEN_DELAY_SECONDS: "1",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("signal received; cleanup begins");
      const discoveryRoot = loggedDiscoveryRoot(lab);
      expect(fs.existsSync(path.dirname(discoveryRoot))).toBe(false);
      expect(processExists(lab.host.pid)).toBe(false);
      expect(processExists(lab.provider.pid)).toBe(false);
    },
    REMOTE_SOAK_KILL_GRACE_TEST_TIMEOUT_MS,
  );

  test("bounds both the SSH carrier and the whole remote shell", () => {
    const source = fs.readFileSync(soakScript, "utf8");
    expect(source).toContain("-o ServerAliveCountMax=3");
    expect(source).toContain(
      '"timeout -k ${cleanup_kill_grace_seconds}s ${timeout_seconds}s sh -s -- $screen_reads"',
    );
    expect(source).toContain("cleanup_kill_grace_seconds=15");
    expect(source).toContain("timeout -k 1s 2s");
  });
});
