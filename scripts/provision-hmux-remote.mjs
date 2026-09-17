#!/usr/bin/env node
// Installs a prebuilt Hmux onto servers that may never have had one, so that a
// phone holding a forced-command key has something to talk to. The laptop runs
// this once per fleet change; it is not on the steady-state path and nothing it
// installs depends on it staying up.
//
// usage:
//   node scripts/provision-hmux-remote.mjs --prebuilt-root <dir> <host> [<host>...]
//
//   <dir> holds one unpacked tree per target triple, named by the triple —
//   exactly what the `Hmux Linux artifacts` archives extract to, and exactly
//   what scripts/package-hmux-prebuilt.sh writes.
//
// options:
//   --json      machine-readable report on stdout instead of lines
//
// environment:
//   HMUX_PROVISION_SSH   ssh executable to use (default: ssh with BatchMode)
//
// Each host is provisioned independently: one unreachable server is one failed
// row, not an aborted run. The process exits non-zero if any row failed, and
// names those hosts, because "provisioning finished" and "every server can
// serve the phone" are different claims.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildProbeScript,
  HostRefusal,
  parseProbeOutput,
  planHostAction,
  quoteForRemoteShell,
  selectPrebuiltTriple,
  summarizeResults,
} from "./lib/hmux-remote-provisioning.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const installScript = path.join(scriptDirectory, "install-hmux.sh");
const REMOTE_COMMAND_PATH = '"$HOME/.local/bin/hmux"';

function fail(message) {
  process.stderr.write(`provision-hmux-remote: ${message}\n`);
  process.exit(2);
}

function parseArguments(argv) {
  const hosts = [];
  let prebuiltRoot = null;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--prebuilt-root") {
      index += 1;
      prebuiltRoot = argv[index];
      if (!prebuiltRoot) {
        fail("--prebuilt-root needs a directory");
      }
      continue;
    }
    // A host is passed to ssh as its own argv element, so a shell cannot be
    // injected through it — but ssh itself would read a leading dash as a
    // flag, which is how a typo turns into an unintended ssh option.
    if (argument.startsWith("-")) {
      fail(`unknown option: ${argument}`);
    }
    hosts.push(argument);
  }
  if (!prebuiltRoot) {
    fail("--prebuilt-root is required");
  }
  if (hosts.length === 0) {
    fail("name at least one host");
  }
  return { hosts, json, prebuiltRoot };
}

function sshCommand() {
  const override = process.env.HMUX_PROVISION_SSH;
  if (override) {
    return [override];
  }
  // BatchMode because provisioning is unattended by definition: a host whose
  // key is not loaded must fail its own row now, not block the whole fleet on
  // a password prompt nobody is watching.
  return ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];
}

function runLocal(command, args, options = {}) {
  const result = spawnSync(command, args, {
    maxBuffer: 256 * 1024 * 1024,
    ...options,
  });
  if (result.error) {
    throw new HostRefusal("local-command-failed", result.error.message);
  }
  const stderr = result.stderr ? result.stderr.toString() : "";
  if (result.status !== 0) {
    throw new HostRefusal(
      "local-command-failed",
      `${command} exited ${result.status}${stderr ? `: ${stderr.trim()}` : ""}`,
    );
  }
  return {
    stderr,
    stdout: result.stdout ? result.stdout.toString() : "",
  };
}

function runRemote(ssh, host, script, { input, reason } = {}) {
  const result = spawnSync(ssh[0], [...ssh.slice(1), host, script], {
    input: input ?? Buffer.alloc(0),
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) {
    throw new HostRefusal("unreachable", result.error.message);
  }
  const stderr = result.stderr ? result.stderr.toString() : "";
  if (result.status !== 0) {
    throw new HostRefusal(
      reason ?? "remote-command-failed",
      `${stderr.trim() || `remote command exited ${result.status}`}`,
    );
  }
  return {
    stderr,
    stdout: result.stdout ? result.stdout.toString() : "",
  };
}

// One local staging directory per triple, reused across hosts: the tree is tens
// of megabytes and copying it per host buys nothing. The two payloads are cut
// from the same directory so the script a host verifies with is byte-identical
// to the script it installs with.
function preparePayloads(prebuiltRoot, triple, cache) {
  const cached = cache.get(triple);
  if (cached) {
    return cached;
  }
  const tree = path.join(prebuiltRoot, triple);
  const manifest = path.join(tree, "install.json");
  if (!fs.existsSync(manifest)) {
    throw new HostRefusal(
      "missing-artifact",
      `no prebuilt tree for ${triple} under ${prebuiltRoot}`,
    );
  }
  const buildId = JSON.parse(fs.readFileSync(manifest, "utf8")).buildId;
  if (!buildId) {
    throw new HostRefusal(
      "missing-artifact",
      `${manifest} does not name a buildId`,
    );
  }

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "hmux-provision-"));
  fs.copyFileSync(installScript, path.join(staging, "install-hmux.sh"));
  fs.cpSync(tree, path.join(staging, "tree"), { recursive: true });

  // The pin is taken here, on the distributor, from the tree that is about to
  // be sent — and by running the very script the remote will re-run, so the two
  // sides cannot drift into disagreeing about what "the digest" means.
  //
  // The operator's own HMUX_* variables are dropped rather than inherited: an
  // HMUX_ARTIFACT_DIR left over from a source build makes install-hmux.sh refuse
  // two competing binary sources, which would read here as a broken artifact.
  const {
    HMUX_ARTIFACT_DIR: _artifactDir,
    HMUX_EXPECTED_DIGEST: _expectedDigest,
    ...localEnvironment
  } = process.env;
  const digest = runLocal("sh", [installScript, "--print-prebuilt-digest"], {
    env: { ...localEnvironment, HMUX_PREBUILT_DIR: path.join(staging, "tree") },
  }).stdout.trim();
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new HostRefusal(
      "missing-artifact",
      `could not compute a digest for ${tree}`,
    );
  }

  // Uncompressed tar over the ssh stream. gzip would save a few megabytes once
  // per host and add a dependency to every target; the thing that establishes
  // what arrived is the digest, not the framing. COPYFILE_DISABLE keeps BSD tar
  // from adding AppleDouble members when the laptop is a Mac.
  const archive = (entries) =>
    spawnSync("tar", ["-cf", "-", "-C", staging, ...entries], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
      maxBuffer: 256 * 1024 * 1024,
    });
  const scriptArchive = archive(["install-hmux.sh"]);
  const treeArchive = archive(["tree"]);
  for (const result of [scriptArchive, treeArchive]) {
    if (result.status !== 0) {
      throw new HostRefusal(
        "missing-artifact",
        `tar failed for ${triple}: ${result.stderr?.toString().trim()}`,
      );
    }
  }

  const payloads = {
    buildId,
    digest,
    scriptPayload: scriptArchive.stdout,
    staging,
    treePayload: treeArchive.stdout,
    triple,
  };
  cache.set(triple, payloads);
  return payloads;
}

function uploadScript(ssh, host, payload) {
  const script = [
    "set -eu",
    'hmux_staging=$(mktemp -d "${TMPDIR:-/tmp}/hmux-provision.XXXXXX")',
    'tar -xf - -C "$hmux_staging"',
    'printf "staging=%s\\n" "$hmux_staging"',
  ].join("\n");
  const output = runRemote(ssh, host, script, {
    input: payload,
    reason: "upload-failed",
  });
  const staging = output.stdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("staging="))
    ?.slice("staging=".length);
  if (!staging) {
    throw new HostRefusal(
      "upload-failed",
      "the remote did not report a staging directory",
    );
  }
  return staging;
}

function readInstalledDigest(ssh, host, staging, buildId) {
  const script = [
    "set -eu",
    `HMUX_PREBUILT_DIR="$HOME/.local/share/hmux/versions"/${quoteForRemoteShell(buildId)} \\`,
    `  sh ${quoteForRemoteShell(`${staging}/install-hmux.sh`)} --print-prebuilt-digest`,
  ].join("\n");
  try {
    const digest = runRemote(ssh, host, script).stdout.trim();
    return /^[0-9a-f]{64}$/.test(digest) ? digest : null;
  } catch {
    // A version directory that will not hash is a planning input, not a fatal
    // error: planHostAction turns it into an explicit refusal with a message
    // an operator can act on.
    return null;
  }
}

function installOnHost(ssh, host, staging, payloads) {
  runRemote(
    ssh,
    host,
    ["set -eu", `tar -xf - -C ${quoteForRemoteShell(staging)}`].join("\n"),
    { input: payloads.treePayload, reason: "upload-failed" },
  );
  const script = [
    "set -eu",
    `HMUX_EXPECTED_DIGEST=${quoteForRemoteShell(payloads.digest)} \\`,
    `  HMUX_PREBUILT_DIR=${quoteForRemoteShell(`${staging}/tree`)} \\`,
    `  sh ${quoteForRemoteShell(`${staging}/install-hmux.sh`)}`,
  ].join("\n");
  return runRemote(ssh, host, script, { reason: "install-refused" }).stdout;
}

// The install already refused a tree whose architecture disagrees with the
// machine, so this is not the arch guard — it is the end-to-end statement that
// the command symlink chain resolves to something this kernel will actually
// run. It is the last step, after `current` has moved, because that is the only
// point at which the question is meaningful.
function confirmCommandRuns(ssh, host) {
  return runRemote(ssh, host, `exec ${REMOTE_COMMAND_PATH} --version`, {
    reason: "installed-command-does-not-run",
  }).stdout.trim();
}

function provisionHost(ssh, host, prebuiltRoot, cache) {
  let staging = null;
  try {
    const probe = parseProbeOutput(
      runRemote(ssh, host, buildProbeScript(), { reason: "unreachable" })
        .stdout,
    );
    const triple = selectPrebuiltTriple(probe);
    const payloads = preparePayloads(prebuiltRoot, triple, cache);
    staging = uploadScript(ssh, host, payloads.scriptPayload);
    const installedDigest = probe.versions.includes(payloads.buildId)
      ? readInstalledDigest(ssh, host, staging, payloads.buildId)
      : null;
    const plan = planHostAction({
      buildId: payloads.buildId,
      expectedDigest: payloads.digest,
      installedDigest,
      probe,
    });

    const common = {
      buildId: payloads.buildId,
      digest: payloads.digest,
      host,
      triple,
    };
    if (plan.action === "refuse") {
      return {
        ...common,
        detail: plan.message,
        outcome: "failed",
        reason: plan.reason,
      };
    }
    if (plan.action === "none") {
      return {
        ...common,
        detail: `${payloads.buildId} is already installed and current`,
        outcome: "already-current",
        version: confirmCommandRuns(ssh, host),
      };
    }
    installOnHost(ssh, host, staging, payloads);
    return {
      ...common,
      detail:
        plan.action === "activate"
          ? `re-pointed current at ${payloads.buildId}`
          : `installed ${payloads.buildId}`,
      outcome: plan.action === "activate" ? "activated" : "installed",
      version: confirmCommandRuns(ssh, host),
    };
  } catch (error) {
    return {
      detail: error.message,
      host,
      outcome: "failed",
      reason: error instanceof HostRefusal ? error.reason : "unexpected-error",
    };
  } finally {
    if (staging) {
      // Best effort: a leftover staging directory is litter, while a failed
      // cleanup that masked the real per-host reason would be a lie.
      try {
        runRemote(ssh, host, `rm -rf ${quoteForRemoteShell(staging)}`);
      } catch {}
    }
  }
}

function main() {
  const { hosts, json, prebuiltRoot } = parseArguments(process.argv.slice(2));
  const ssh = sshCommand();
  const cache = new Map();
  const results = hosts.map((host) =>
    provisionHost(ssh, host, prebuiltRoot, cache),
  );
  for (const payloads of cache.values()) {
    fs.rmSync(payloads.staging, { force: true, recursive: true });
  }

  const summary = summarizeResults(results);
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ hosts: results, schemaVersion: 1, summary }, null, 2)}\n`,
    );
  } else {
    for (const result of results) {
      const label = result.outcome === "failed" ? "FAILED" : result.outcome;
      process.stdout.write(`${result.host}: ${label} — ${result.detail}\n`);
    }
    process.stdout.write(
      `${summary.changed.length} changed, ${summary.unchanged.length} already current, ${summary.failed.length} failed\n`,
    );
    if (summary.failed.length > 0) {
      process.stdout.write(`not provisioned: ${summary.failed.join(", ")}\n`);
    }
  }
  process.exit(summary.failed.length > 0 ? 1 : 0);
}

main();
