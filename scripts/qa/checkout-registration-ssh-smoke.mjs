#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BOUNDED_GROUP_COMPLETION,
  runBoundedOwnedProcessGroup,
} from "./lib/bounded-owned-process-group.mjs";

const self = fileURLToPath(import.meta.url);
const repository = path.resolve(path.dirname(self), "../..");
const targets = ["aarch64-unknown-linux-musl", "x86_64-unknown-linux-musl"];
const guest = "/tmp/dure-checkout-ssh.fixture";
const vm = "checkout";
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function smoke(root) {
  assert(process.platform === "darwin" && process.arch === "arm64", "Requires the macOS ARM64 Lima host");
  assert(path.dirname(root) === "/tmp" && path.basename(root).startsWith("dure-checkout-ssh."));
  for (const directory of ["home", "lima", "commands", "discovery", "tmp", "app"]) {
    fs.mkdirSync(path.join(root, directory), { mode: 0o700 });
  }
  console.log(`Checkout registration SSH evidence: ${root}`);
  const environment = {
    PATH: process.env.PATH, USER: process.env.USER, LOGNAME: process.env.LOGNAME,
    HOME: path.join(root, "home"), LIMA_HOME: path.join(root, "lima"),
    DURE_HOME: path.join(root, "app"), HMUX_DISCOVERY_ROOT: path.join(root, "discovery"),
    TMPDIR: path.join(root, "tmp"), LANG: "en_US.UTF-8",
    SSH: "ssh -o ControlMaster=no -o ControlPersist=no -o ControlPath=none",
  };
  let started = false;
  let cleanupVerified = false;
  const observations = [];

  async function command(program, args, { input, environment: extraEnvironment } = {}) {
    const commandEnvironment = { ...environment, ...extraEnvironment };
    const control = fs.mkdtempSync(path.join(root, "commands/command-"));
    fs.writeFileSync(path.join(control, "request.json"), JSON.stringify({
      command: program, args, environment: commandEnvironment, input,
    }), { flag: "wx", mode: 0o600 });
    const child = spawn(program, args, { cwd: repository, env: commandEnvironment, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (bytes) => { stdout = (stdout + bytes.toString()).slice(-4 * 1024 * 1024); });
    child.stderr.on("data", (bytes) => { stderr = (stderr + bytes.toString()).slice(-4 * 1024 * 1024); });
    child.stdin.on("error", (error) => { if (error.code !== "EPIPE") throw error; });
    child.stdin.end(input ?? "");
    const [code, signal] = await once(child, "close");
    const result = { code, signal, stdout, stderr };
    fs.writeFileSync(path.join(control, "result.json"), JSON.stringify(result), { mode: 0o600 });
    assert.equal(signal, null);
    return result;
  }
  const lima = (args, options) => command("limactl", args, options);
  async function ok(args, options) {
    const result = await lima(args, options);
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.trim();
  }
  const shell = (script) => ok(["shell", "--tty=false", vm, "sh", "-s"], { input: script });
  async function invoke(target, operation, request, binDirectory = "/usr/bin:/bin") {
    const scope = `${guest}/${target}`;
    const start = performance.now();
    const result = await lima(["shell", "--tty=false", vm, "env", "-i",
      `PATH=${binDirectory}`, `HOME=${scope}/home`, `DURE_HOME=${scope}/app`,
      `HMUX_DISCOVERY_ROOT=${scope}/discovery`, `DURE_QA_CHECKOUT_SCOPE=${scope}`,
      `${guest}/helper-${target}`, operation], {
      input: request === undefined ? "" : JSON.stringify(request),
    });
    observations.push({ target, operation, code: result.code, elapsedMs: Math.round(performance.now() - start) });
    return { ...result, body: JSON.parse(result.stdout) };
  }
  const success = (result) => {
    assert.equal(result.code, 0, JSON.stringify(result.body));
    assert.equal(result.body.schemaVersion, 1);
    return result.body.value;
  };
  const failure = (result, code) => {
    assert.equal(result.code, 50, JSON.stringify(result.body));
    assert.equal(result.body.error.code, code);
    return result.body.error;
  };

  let error;
  const artifacts = {};
  let tauriObservation;
  let tauriLifecycleObservation;
  try {
    assert.equal(await ok(["--version"]), "limactl version 1.2.1");
    assert.equal(await ok(["list", "-q"]), "");
    started = true;
    await ok(["start", "--tty=false", "--name", vm, "--cpus", "2", "--memory", "2",
      "--timeout", "10m", path.join(repository, "scripts/qa/hmux-linux-artifact-lima.yaml")]);
    await shell(`set -eu\nmkdir -m 700 ${quote(guest)}\ncommand -v git\n`);

    for (const target of targets) {
      const binary = path.join(repository, "src-tauri/resources/remote-git-checkout-helper", target,
        "dure-git-checkout-helper");
      const bytes = fs.readFileSync(binary);
      artifacts[target] = { sha256: sha256(bytes), bytes: bytes.length };
      await ok(["copy", binary, `${vm}:${guest}/helper-${target}`]);
      await shell(`set -eu\nchmod 700 ${quote(`${guest}/helper-${target}`)}\n`);
      const capabilities = success(await invoke(target, "capabilities-v1"));
      assert(capabilities.operations.includes("session-v1"));
      const scope = `${guest}/${target}`;
      await shell(`set -eu
mkdir -p ${quote(`${scope}/home`)} ${quote(`${scope}/repository`)} ${quote(`${scope}/bin`)}
git -C ${quote(`${scope}/repository`)} init -q
git -C ${quote(`${scope}/repository`)} config user.name 'Checkout SSH QA'
git -C ${quote(`${scope}/repository`)} config user.email fixture@example.invalid
printf 'preserve this until confirmed removal\n' > ${quote(`${scope}/repository/tracked`)}
git -C ${quote(`${scope}/repository`)} add tracked
git -C ${quote(`${scope}/repository`)} -c core.hooksPath=/dev/null -c commit.gpgsign=false commit -qm fixture
git -C ${quote(`${scope}/repository`)} worktree add -q -b fixture ${quote(`${scope}/checkout`)}
`);
      const capture = success(await invoke(target, "capture-v1", {
        repositoryPath: `${scope}/repository`, checkoutPath: `${scope}/checkout`,
      }));
      const context = {
        applicationHome: `${scope}/app`, userHome: `${scope}/home`,
        discoveryRoot: `${scope}/discovery`,
      };
      const registration = {
        context, command: { kind: "register_agent", request: {
          registrationId: "ssh-incarnation-one",
          agent: { agentId: "ssh-helper-agent", runtimeWorkspaceId: "ssh-workspace", providerId: "local-shell",
            workingDirectory: `${scope}/checkout`, displayName: "SSH registration fixture" },
        } },
      };
      const removal = { repositoryPath: `${scope}/repository`, instance: capture, policy: "require_clean" };
      const first = success(await invoke(target, "session-v1", registration));
      assert.deepEqual(success(await invoke(target, "session-v1", registration)), first);
      failure(await invoke(target, "remove-v1", removal), "checkout_use_in_use");
      await shell(`test -f ${quote(`${scope}/checkout/tracked`)}\n`);
      const newcomer = structuredClone(registration);
      newcomer.command.request.registrationId = "ssh-incarnation-two";
      failure(await invoke(target, "session-v1", newcomer), "session_checkout_failed");
      assert.deepEqual(success(await invoke(target, "session-v1", registration)), first);
      const close = { context, command: { kind: "close_agent_registration", binding: first.binding } };
      assert.equal(success(await invoke(target, "session-v1", close)), null);
      assert.equal(success(await invoke(target, "session-v1", close)), null);
      failure(await invoke(target, "session-v1", registration), "session_checkout_failed");
      assert.equal(success(await invoke(target, "remove-v1", removal)).outcome, "removed");
      await shell(`test ! -e ${quote(`${scope}/checkout`)}\n`);

      // Hold the actual Git deletion call after its removal permit has been
      // acquired. Another SSH connection must not publish an Agent during it.
      await shell(`set -eu
git -C ${quote(`${scope}/repository`)} worktree add -q -b permit-first ${quote(`${scope}/checkout`)}
mkfifo ${quote(`${scope}/permit-release`)}
`);
      await ok(["copy", path.join(repository, "scripts/qa/checkout-registration-git-fixture.sh"),
        `${vm}:${scope}/bin/git`]);
      await shell(`chmod 700 ${quote(`${scope}/bin/git`)}\n`);
      const permitCapture = success(await invoke(target, "capture-v1", {
        repositoryPath: `${scope}/repository`, checkoutPath: `${scope}/checkout`,
      }));
      const permitRemoval = { ...removal, instance: permitCapture };
      const permitRegistration = structuredClone(registration);
      permitRegistration.command.request.registrationId = "ssh-permit-incarnation";
      permitRegistration.command.request.agent.agentId = "ssh-permit-agent";
      permitRegistration.command.request.agent.runtimeWorkspaceId = "ssh-permit-workspace";
      // Observe rejection immediately while the other connection waits for the
      // permit. Reconcile both commands even if releasing the fixture fails.
      const pendingRemoval = Promise.allSettled([
        invoke(target, "remove-v1", permitRemoval, `${scope}/bin:/usr/bin:/bin`),
      ]);
      let removed;
      try {
        await shell(`while [ ! -f ${quote(`${scope}/permit-ready`)} ]; do sleep 0.02; done\n`);
        const refused = failure(await invoke(target, "session-v1", permitRegistration), "session_checkout_failed");
        assert.match(refused.message, /checkout_use_phase_conflict/);
      } finally {
        const [released, [removal]] = await Promise.all([
          Promise.allSettled([
            shell(`timeout 3 sh -c ${quote(`printf 'release\\n' > ${quote(`${scope}/permit-release`)}`)}\n`),
          ]),
          pendingRemoval,
        ]);
        for (const result of [...released, removal]) {
          if (result.status === "rejected") throw result.reason;
        }
        removed = removal.value;
      }
      assert.equal(success(removed).outcome, "removed");
      failure(await invoke(target, "session-v1", permitRegistration), "session_checkout_failed");
      await shell(`test ! -e ${quote(`${scope}/checkout`)}\n`);
      console.log(`SSH registration lifetime passed: ${target}`);
    }

    const tauriBinary = process.env.DURE_QA_CHECKOUT_TAURI_TEST_BINARY;
    if (tauriBinary) {
      const listing = JSON.parse(await ok(["list", vm, "--json"]));
      const user = await shell("id -un\n");
      const key = await shell("sudo cat /etc/ssh/ssh_host_ed25519_key.pub\n");
      const fingerprint = `SHA256:${createHash("sha256").update(Buffer.from(key.split(/\s+/u)[1], "base64")).digest("base64").replace(/=+$/u, "")}`;
      const scope = `${guest}/tauri`;
      await shell(`set -eu
test ! -e "$HOME/.local/bin/hmux-runtime"
mkdir -p ${quote(`${scope}/repository`)}
git -C ${quote(`${scope}/repository`)} init -q
git -C ${quote(`${scope}/repository`)} -c user.name=Fixture -c user.email=fixture@example.invalid -c core.hooksPath=/dev/null -c commit.gpgsign=false commit --allow-empty -qm fixture
git -C ${quote(`${scope}/repository`)} worktree add -q -b tauri-fixture ${quote(`${scope}/checkout`)}
`);
      const contents = path.join(root, "CheckoutFixture.app/Contents");
      const executable = path.join(contents, "MacOS/checkout-tests");
      fs.mkdirSync(path.dirname(executable), { recursive: true, mode: 0o700 });
      fs.copyFileSync(tauriBinary, executable);
      fs.chmodSync(executable, 0o700);
      for (const target of targets) {
        const destination = path.join(contents, "Resources/resources/remote-git-checkout-helper", target);
        fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
        fs.copyFileSync(path.join(repository, "src-tauri/resources/remote-git-checkout-helper", target, "dure-git-checkout-helper"), path.join(destination, "dure-git-checkout-helper"));
      }
      const resources = path.join(contents, "Resources/resources");
      for (const target of targets) {
        const source = path.join(repository, "src-tauri/resources/hmux-remote", target);
        const manifest = JSON.parse(fs.readFileSync(path.join(source, "install.json"), "utf8"));
        const runtime = fs.readFileSync(path.join(source, "bin/hmux-runtime"));
        artifacts[target].runtime = { buildId: manifest.buildId, sha256: sha256(runtime), bytes: runtime.length };
        fs.cpSync(source, path.join(resources, "hmux-remote", target), { recursive: true });
      }
      fs.copyFileSync(path.join(repository, "scripts/install-hmux.sh"), path.join(resources, "install-hmux.sh"));
      const fixturePath = path.join(root, "tauri-fixture.json");
      fs.writeFileSync(fixturePath, JSON.stringify({
        ssh: { host: "127.0.0.1", port: listing.sshLocalPort, user, auth: "key",
          keyPath: path.join(root, "lima/_config/user"), hostKeyFingerprints: [fingerprint] },
        checkout: `${scope}/checkout`,
      }), { flag: "wx", mode: 0o600 });
      // macOS Tauri rejects executable paths containing the /tmp symlink.
      // Launch the same owned fixture through its canonical path.
      tauriObservation = await command(fs.realpathSync(executable), [
        "session_checkout::remote::tests::ssh_registration_upload_and_cancel_without_a_runtime",
        "--exact", "--ignored", "--nocapture", "--test-threads=1",
      ], { environment: { DURE_QA_CHECKOUT_SSH_FIXTURE: fixturePath } });
      assert.equal(tauriObservation.code, 0, tauriObservation.stdout + tauriObservation.stderr);
      await shell('test ! -e "$HOME/.local/bin/hmux-runtime"\n');
      console.log("Tauri resource upload and libssh2 registration lifetime passed without a runtime");
      await shell(`set -eu
! command -v claude >/dev/null 2>&1
printf '%s\\n' '#!/bin/sh' 'exec /bin/cat' | sudo tee /usr/local/bin/claude >/dev/null
sudo chmod 755 /usr/local/bin/claude
git -C ${quote(`${scope}/repository`)} worktree add -q -b native-plain ${quote(`${scope}/plain`)}
git -C ${quote(`${scope}/repository`)} worktree add -q -b native-registered ${quote(`${scope}/registered`)}
`);
      tauriLifecycleObservation = await command(fs.realpathSync(executable), [
        "session_checkout::remote::tests::ssh_managed_lifecycle_owns_checkout_until_resource_removal",
        "--exact", "--ignored", "--nocapture", "--test-threads=1",
      ], { environment: { DURE_QA_CHECKOUT_SSH_FIXTURE: fixturePath } });
      // Preserve native state before the outer VM cleanup, including on RED.
      // A failed assertion alone does not establish whether Git removed a live checkout.
      tauriLifecycleObservation.after = await shell(`
for checkout in ${quote(`${scope}/plain`)} ${quote(`${scope}/registered`)}; do
  if [ -e "$checkout" ]; then printf 'present: %s\\n' "$checkout"; else printf 'absent: %s\\n' "$checkout"; fi
done
if [ -x "$HOME/.local/bin/hmux" ]; then "$HOME/.local/bin/hmux" --json ls; fi
`);
      assert.equal(tauriLifecycleObservation.code, 0, tauriLifecycleObservation.stdout + tauriLifecycleObservation.stderr);
      console.log("Tauri managed SSH create/replay/advance/close preserved exact checkout lifetime");
    }
  } catch (cause) {
    error = cause;
  } finally {
    if (started) {
      try {
        // VM ownership is confined to a freshly allocated LIMA_HOME. Do not
        // signal a discovered PID or infer absence from a failed stop request.
        await lima(["stop", "--force", vm]);
        await lima(["delete", "--force", vm]);
        assert.equal(await ok(["list", "-q"]), "");
        cleanupVerified = true;
      } catch (cause) { error ??= cause; }
    }
    const report = { ok: !error && cleanupVerified, root, artifacts, observations, tauriObservation, tauriLifecycleObservation,
      cleanupVerified, error: error?.message ?? null,
      boundary: tauriObservation
        ? "Both Linux helper architectures; ARM64 production Tauri resource/libssh2 and managed lifecycle with mock app handle and shell provider; no WebView/real-provider proof"
        : "one-shot Linux helpers over independent Lima SSH calls; no Tauri/WebView/provider proof" };
    fs.writeFileSync(path.join(root, "summary.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(report));
  }
  if (error) throw error;
  assert(cleanupVerified, "VM cleanup was not verified; preserve the evidence root");
}

if (process.argv[2] === "--worker") await smoke(process.argv[3]);
else {
  const root = fs.mkdtempSync("/tmp/dure-checkout-ssh.");
  fs.chmodSync(root, 0o700);
  const control = path.join(root, "control");
  fs.mkdirSync(control, { mode: 0o700 });
  // One supervision scope owns the complete VM lifecycle. Completing a short
  // `limactl start` command must not retire its intentionally persistent VM.
  process.exitCode = await runBoundedOwnedProcessGroup(control, "1200", process.execPath,
    [self, "--worker", root]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(control, "completion.json"), "utf8")),
    BOUNDED_GROUP_COMPLETION);
}
