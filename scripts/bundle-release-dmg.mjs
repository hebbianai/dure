#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  DEFAULT_HOST_RESOURCE_POLICY,
  waitForHostResources,
} from "./lib/host-resource-admission.mjs";
import { RELEASE_HOST_MAX_LOAD_PER_CORE } from "./lib/release-host-admission.mjs";
import {
  loadTauriConfig,
  releaseDmgSettings,
  renderFinderLayoutScript,
} from "./lib/release-dmg-settings.mjs";

export const RELEASE_DMG_DEFAULTS = Object.freeze({
  layoutAttempts: 2,
  attemptTimeoutSeconds: 240,
  layoutWaitSeconds: 180,
  dsStoreWaitSeconds: 60,
});

const HELP = `Usage: node scripts/bundle-release-dmg.mjs [options]
Package the already built, signed and notarized <Product>.app from the Tauri
bundle directory into dmg/<Product>_<version>_<arch>.dmg the way tauri-bundler
does, without rebuilding, re-signing or re-notarizing the app. Finder layout
attempts (background, icon positions) run under a deadline and are retried;
once they are exhausted a plain disk image is produced instead of failing.
  --tauri-dir DIR              Tauri source directory (default src-tauri)
  --bundle-root DIR            Bundle directory (default <tauri-dir>/target/release/bundle)
  --config FILE                Extra Tauri config file(s), as passed to tauri build
  --sign                       Sign the image with $APPLE_SIGNING_IDENTITY (required then)
  --layout-attempts N          Finder layout attempts before the plain fallback (default ${RELEASE_DMG_DEFAULTS.layoutAttempts})
  --plain                      No Finder layout at all (same as --layout-attempts 0)
  --attempt-timeout-seconds S  Deadline per attempt; its process group is killed (default ${RELEASE_DMG_DEFAULTS.attemptTimeoutSeconds})
  --layout-wait-seconds S      Before each layout attempt wait up to S seconds for the
                               one-minute load per core to drop under the limit (default ${RELEASE_DMG_DEFAULTS.layoutWaitSeconds}; 0 disables)
  --max-load-per-core N        That load limit (default ${RELEASE_HOST_MAX_LOAD_PER_CORE})
  --log-dir DIR                Per-attempt command logs and summary.json (default <tmp>/dure-dmg-logs)
Every command's output is logged; the signing identity is redacted.
`;

const activeGroups = new Set();

function redactText(text, secrets) {
  let result = text;
  for (const secret of secrets) if (secret) result = result.replaceAll(secret, "<redacted>");
  return result;
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    /* already gone */
  }
}

export function killActiveProcessGroups(signal = "SIGTERM") {
  for (const pid of activeGroups) signalGroup(pid, signal);
}

/** Run one command in its own process group under an absolute deadline. Every
 * output line is logged (redacted) as it arrives and the complete output is
 * returned. A nonzero exit rejects with release_dmg_step_failed; the deadline
 * kills the whole group and rejects with release_dmg_attempt_timeout. */
export function runStep(
  command,
  args,
  { cwd, deadline, log = () => {}, redact = [], env = process.env, tolerateFailure = false } = {},
) {
  const printable = redactText([command, ...args].join(" "), redact);
  const remaining = deadline - Date.now();
  if (!(remaining > 0)) {
    return Promise.reject(new Error(`release_dmg_attempt_timeout: no time left to run ${printable}`));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    log(`$ ${printable}`);
    const started = Date.now();
    const output = { stdout: "", stderr: "" };
    const forward = (stream, name) => {
      let pending = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        output[name] += chunk;
        pending += chunk;
        const lines = pending.split("\n");
        pending = lines.pop();
        for (const line of lines) if (line.trim()) log(`${name}: ${redactText(line, redact)}`);
      });
      stream.on("end", () => {
        if (pending.trim()) log(`${name}: ${redactText(pending, redact)}`);
      });
    };
    forward(child.stdout, "stdout");
    forward(child.stderr, "stderr");
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      log(`deadline reached after ${Math.round((Date.now() - started) / 1000)}s; terminating the process group of ${printable}`);
      signalGroup(child.pid, "SIGTERM");
      setTimeout(() => signalGroup(child.pid, "SIGKILL"), 5_000).unref();
    }, remaining);
    child.once("spawn", () => activeGroups.add(child.pid));
    child.once("error", (error) => {
      clearTimeout(timer);
      activeGroups.delete(child.pid);
      if (settled) return;
      settled = true;
      reject(new Error(`release_dmg_step_failed: ${printable}: ${error.message}`));
    });
    child.once("exit", (status, signal) => {
      clearTimeout(timer);
      activeGroups.delete(child.pid);
      const complete = () => {
        if (settled) return;
        settled = true;
        // Never wait on a straggler that inherited the pipes (the hang in #308).
        child.stdout.destroy();
        child.stderr.destroy();
        const durationMs = Date.now() - started;
        if (timedOut) {
          reject(new Error(`release_dmg_attempt_timeout: ${printable} exceeded the attempt deadline and its process group was killed`));
        } else if (status === 0 || tolerateFailure) {
          resolve({ status, signal, durationMs, ...output });
        } else {
          const detail = output.stderr.trim().split("\n").at(-1);
          reject(new Error(
            `release_dmg_step_failed: ${printable} exited ${status ?? `from ${signal}`}${detail ? `: ${redactText(detail, redact)}` : ""}`,
          ));
        }
      };
      child.once("close", complete);
      setTimeout(complete, 2_000).unref();
    });
  });
}

function copyVolumeIcon(icon, mountPoint) {
  const target = path.join(mountPoint, ".VolumeIcon.icns");
  fs.copyFileSync(icon, target);
  return target;
}

async function parseAttachment(plist, workDir, step) {
  const file = path.join(workDir, "attach.plist");
  fs.writeFileSync(file, plist);
  const json = await step("plutil", ["-convert", "json", "-o", "-", file]);
  const entities = JSON.parse(json.stdout)["system-entities"] ?? [];
  const mounted = entities.find((entity) => entity["mount-point"] && entity["dev-entry"]);
  if (!mounted) throw new Error("release_dmg_mount_missing: hdiutil attach reported no mounted volume");
  return { device: mounted["dev-entry"], mountPoint: mounted["mount-point"] };
}

async function detachImage(device, { run, deadline, log, force = false }) {
  for (let attempt = 1; ; attempt++) {
    try {
      const forced = force || attempt === 3;
      await run("hdiutil", ["detach", ...(forced ? ["-force"] : []), device], { deadline, log });
      return;
    } catch (error) {
      if (attempt >= 3) throw error;
      log(`detach attempt ${attempt} failed (${error.message}); retrying`);
      await delay(2_000);
    }
  }
}

async function waitForFile(file, { deadline, maxWaitMs, log }) {
  const limit = Math.min(deadline, Date.now() + maxWaitMs);
  while (!fs.existsSync(file)) {
    if (Date.now() >= limit) {
      throw new Error(`release_dmg_layout_unsaved: Finder did not write ${path.basename(file)} within ${Math.round(maxWaitMs / 1000)}s`);
    }
    await delay(1_000);
  }
  log(`${path.basename(file)} written by Finder`);
}

/** One attempt: the UDRW image, the Applications link, background and volume
 * icon, the optional Finder layout, then UDZO compression and signing. The
 * app bundle is copied by hdiutil as is; nothing in it is touched. */
export async function createDiskImage({
  settings,
  appPath,
  outputDir,
  layout,
  deadline,
  log,
  identity = null,
  mountRoot = null,
  workRoot = os.tmpdir(),
  run = runStep,
  dsStoreWaitMs = RELEASE_DMG_DEFAULTS.dsStoreWaitSeconds * 1000,
}) {
  const workDir = fs.mkdtempSync(path.join(workRoot, "dure-dmg-"));
  const rwImage = path.join(workDir, "rw.dmg");
  const finalImage = path.join(outputDir, settings.dmgName);
  const step = (command, args, options = {}) => run(command, args, { deadline, log, ...options });
  let device = null;
  try {
    const usage = await step("du", ["-sk", appPath]);
    const kilobytes = Number(/^\s*(\d+)/.exec(usage.stdout)?.[1]);
    if (!Number.isFinite(kilobytes)) throw new Error(`release_dmg_app_size_unknown: ${usage.stdout.trim()}`);
    // Room for the background, the volume icon and Finder's .DS_Store.
    const megabytes = Math.ceil(kilobytes / 1024) + 32;
    await step("hdiutil", [
      "create", "-srcfolder", appPath, "-volname", settings.volumeName,
      "-fs", "HFS+", "-fsargs", "-c c=64,a=16,e=16", "-format", "UDRW",
      "-size", `${megabytes}m`, rwImage,
    ]);
    const attached = await step("hdiutil", [
      "attach", "-mountrandom", mountRoot ?? workDir, "-readwrite", "-noverify",
      "-noautoopen", "-nobrowse", "-plist", rwImage,
    ]);
    const mounted = await parseAttachment(attached.stdout, workDir, step);
    device = mounted.device;
    const { mountPoint } = mounted;
    log(`mounted ${device} at ${mountPoint}`);
    fs.symlinkSync("/Applications", path.join(mountPoint, "Applications"));
    if (settings.background) {
      fs.mkdirSync(path.join(mountPoint, ".background"));
      fs.copyFileSync(settings.background, path.join(mountPoint, ".background", path.basename(settings.background)));
    }
    // The volume icon is cosmetic and SetFile ships with Xcode, not macOS:
    // its absence must not fail a release the way the bundler's script does.
    const volumeIcon = settings.volumeIcon
      ? (await step("SetFile", ["-c", "icnC", copyVolumeIcon(settings.volumeIcon, mountPoint)], { tolerateFailure: true })).status === 0
      : false;
    if (settings.volumeIcon && !volumeIcon) log("volume icon not applied: SetFile is unavailable or failed");
    if (layout) {
      const script = path.join(workDir, "finder-layout.applescript");
      fs.writeFileSync(script, renderFinderLayoutScript(settings));
      // create-dmg's workaround for Finder's occasional "Can't get disk" (-1728).
      await delay(2_000);
      await step("/usr/bin/osascript", [script, path.basename(mountPoint)]);
      await waitForFile(path.join(mountPoint, ".DS_Store"), { deadline, maxWaitMs: dsStoreWaitMs, log });
    }
    await step("chmod", ["-Rf", "go-w", mountPoint], { tolerateFailure: true });
    if (volumeIcon) await step("SetFile", ["-a", "C", mountPoint], { tolerateFailure: true });
    fs.rmSync(path.join(mountPoint, ".fseventsd"), { recursive: true, force: true });
    await detachImage(device, { run, deadline, log });
    device = null;
    fs.rmSync(finalImage, { force: true });
    await step("hdiutil", ["convert", rwImage, "-format", "UDZO", "-imagekey", "zlib-level=9", "-o", finalImage]);
    if (identity) {
      await step("codesign", ["--force", "--sign", identity, "--timestamp", finalImage], { redact: [identity] });
      await step("codesign", ["--verify", "--strict", finalImage]);
    }
    return finalImage;
  } finally {
    let attached = Boolean(device);
    if (attached) {
      // Cleanup gets its own short deadline; the attempt's may have passed.
      try {
        await detachImage(device, { run, deadline: Date.now() + 30_000, log, force: true });
        attached = false;
      } catch (error) {
        log(`leaving ${device} attached and ${workDir} in place: ${error.message}`);
      }
    }
    if (!attached) fs.rmSync(workDir, { recursive: true, force: true });
  }
}

async function waitForLowLoad({ waitForHost, maxWaitMs, maxLoadPerCore, log }) {
  const policy = Object.freeze({
    ...DEFAULT_HOST_RESOURCE_POLICY,
    enabled: true,
    maxLoadPerCore,
    memoryPressureCeiling: "warning",
  });
  const report = (receipt) => {
    const observed = receipt.observation ?? {};
    const load = Number.isFinite(observed.loadPerCore) ? observed.loadPerCore.toFixed(1) : "unknown";
    log(`host ${receipt.state}: one-minute load per core ${load} (limit ${maxLoadPerCore}), memory pressure ${observed.memoryPressure ?? "unknown"}${receipt.reasonCodes?.length ? ` [${receipt.reasonCodes.join(", ")}]` : ""}`);
  };
  try {
    await waitForHost({
      policyPath: "bundle-release-dmg",
      readPolicy: () => policy,
      maxWaitMs,
      label: "DMG Finder layout",
      report,
    });
  } catch (error) {
    log(`host still busy after ${Math.round(maxWaitMs / 1000)}s (${error.message}); attempting the layout anyway`);
  }
}

/** Layout attempts, then the plain fallback. Each attempt gets a fresh work
 * directory, its own deadline and its own log file in logDir. */
export async function bundleReleaseDmg({
  settings,
  bundleRoot,
  identity = null,
  layoutAttempts = RELEASE_DMG_DEFAULTS.layoutAttempts,
  attemptTimeoutMs = RELEASE_DMG_DEFAULTS.attemptTimeoutSeconds * 1000,
  layoutWaitMs = RELEASE_DMG_DEFAULTS.layoutWaitSeconds * 1000,
  maxLoadPerCore = RELEASE_HOST_MAX_LOAD_PER_CORE,
  logDir,
  workRoot = os.tmpdir(),
  layoutMountRoot = "/Volumes",
  create = createDiskImage,
  waitForHost = waitForHostResources,
  echo = (line) => process.stdout.write(`${line}\n`),
  now = Date.now,
}) {
  if (!Number.isInteger(layoutAttempts) || layoutAttempts < 0) {
    throw new Error("release_dmg_option_invalid: layout attempts must be a nonnegative integer");
  }
  if (!(attemptTimeoutMs > 0) || !(layoutWaitMs >= 0)) {
    throw new Error("release_dmg_option_invalid: the attempt timeout must be positive and the layout wait nonnegative");
  }
  const appPath = path.join(bundleRoot, "macos", settings.appName);
  if (!fs.existsSync(appPath) || !fs.statSync(appPath).isDirectory()) {
    throw new Error(`release_dmg_app_missing: ${appPath} was not produced by the build`);
  }
  const outputDir = path.join(bundleRoot, "dmg");
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  const plan = [...Array(layoutAttempts).fill("layout"), "plain"];
  const attempts = [];
  const writeSummary = (result) => fs.writeFileSync(
    path.join(logDir, "summary.json"),
    `${JSON.stringify({ dmgName: settings.dmgName, layoutAttempts, attemptTimeoutMs, attempts, ...result }, null, 2)}\n`,
  );
  for (const [index, mode] of plan.entries()) {
    const attempt = index + 1;
    const logFile = path.join(logDir, `attempt-${attempt}-${mode}.log`);
    const log = (line) => {
      const stamped = `${new Date().toISOString()} ${line}`;
      fs.appendFileSync(logFile, `${stamped}\n`);
      echo(`[dmg ${attempt}/${plan.length} ${mode}] ${line}`);
    };
    const started = now();
    try {
      if (mode === "layout" && layoutWaitMs > 0) {
        await waitForLowLoad({ waitForHost, maxWaitMs: layoutWaitMs, maxLoadPerCore, log });
      }
      const dmg = await create({
        settings,
        appPath,
        outputDir,
        layout: mode === "layout",
        deadline: now() + attemptTimeoutMs,
        log,
        identity,
        mountRoot: mode === "layout" ? layoutMountRoot : null,
        workRoot,
      });
      attempts.push({ attempt, mode, ok: true, durationMs: now() - started, log: logFile });
      log(`packaged ${dmg}`);
      const result = { dmg, mode, attempts };
      writeSummary({ ok: true, dmg, mode });
      return result;
    } catch (error) {
      log(`failed: ${error.message}`);
      attempts.push({ attempt, mode, ok: false, durationMs: now() - started, error: error.message, log: logFile });
      fs.rmSync(path.join(outputDir, settings.dmgName), { force: true });
    }
  }
  writeSummary({ ok: false });
  throw new Error(
    `release_dmg_bundle_failed: ${attempts.map((entry) => `${entry.mode} attempt ${entry.attempt}: ${entry.error}`).join("; ")}`,
  );
}

function integerOption(values, name, fallback) {
  const raw = values[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`release_dmg_option_invalid: --${name} must be a nonnegative integer`);
  return Number(raw);
}

export async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean" },
      "tauri-dir": { type: "string", default: "src-tauri" },
      "bundle-root": { type: "string" },
      config: { type: "string", multiple: true, default: [] },
      sign: { type: "boolean", default: false },
      "layout-attempts": { type: "string" },
      plain: { type: "boolean", default: false },
      "attempt-timeout-seconds": { type: "string" },
      "layout-wait-seconds": { type: "string" },
      "max-load-per-core": { type: "string" },
      "log-dir": { type: "string" },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (process.platform !== "darwin") throw new Error("release_dmg_requires_macos: disk images are packaged on macOS only");
  const tauriDir = path.resolve(values["tauri-dir"]);
  const bundleRoot = path.resolve(values["bundle-root"] ?? path.join(tauriDir, "target", "release", "bundle"));
  const settings = releaseDmgSettings(
    loadTauriConfig(tauriDir, values.config.map((file) => path.resolve(file))),
    { tauriDir },
  );
  let identity = null;
  if (values.sign) {
    identity = process.env.APPLE_SIGNING_IDENTITY?.trim() || null;
    if (!identity) throw new Error("release_dmg_signing_identity_required: --sign needs APPLE_SIGNING_IDENTITY");
  }
  const layoutAttempts = values.plain ? 0 : integerOption(values, "layout-attempts", RELEASE_DMG_DEFAULTS.layoutAttempts);
  const attemptTimeoutSeconds = integerOption(values, "attempt-timeout-seconds", RELEASE_DMG_DEFAULTS.attemptTimeoutSeconds);
  const layoutWaitSeconds = integerOption(values, "layout-wait-seconds", RELEASE_DMG_DEFAULTS.layoutWaitSeconds);
  const maxLoadPerCore = values["max-load-per-core"] === undefined
    ? RELEASE_HOST_MAX_LOAD_PER_CORE
    : Number(values["max-load-per-core"]);
  if (!(maxLoadPerCore > 0)) throw new Error("release_dmg_option_invalid: --max-load-per-core must be positive");
  const logDir = path.resolve(values["log-dir"] ?? path.join(os.tmpdir(), "dure-dmg-logs"));
  const result = await bundleReleaseDmg({
    settings,
    bundleRoot,
    identity,
    layoutAttempts,
    attemptTimeoutMs: attemptTimeoutSeconds * 1000,
    layoutWaitMs: layoutWaitSeconds * 1000,
    maxLoadPerCore,
    logDir,
  });
  const fallback = result.mode === "plain" && layoutAttempts > 0;
  const summary = fallback
    ? `DMG fallback: ${path.basename(result.dmg)} was packaged without the Finder layout after ${layoutAttempts} failed layout attempt(s). Inspect the release-dmg-logs artifact before accepting the release.`
    : `DMG packaged (${result.mode}) on attempt ${result.attempts.length}: ${path.basename(result.dmg)}`;
  process.stdout.write(`${summary}\n`);
  if (fallback) process.stdout.write(`::warning::${summary}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    process.on(signal, () => {
      killActiveProcessGroups("SIGTERM");
      process.exit(code);
    });
  }
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
