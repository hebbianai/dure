import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RELEASE_DMG_DEFAULTS,
  bundleReleaseDmg,
  createDiskImage,
  runStep,
} from "./bundle-release-dmg.mjs";
import { releaseDmgSettings } from "./lib/release-dmg-settings.mjs";

const roots = [];
function root(prefix = "dure-dmg-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = root();
  const bundleRoot = path.join(dir, "bundle");
  const binary = path.join(bundleRoot, "macos", "Fixture.app", "Contents", "MacOS");
  fs.mkdirSync(binary, { recursive: true });
  fs.writeFileSync(path.join(binary, "fixture"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const settings = releaseDmgSettings(
    { productName: "Fixture", version: "1.2.3" },
    { tauriDir: dir, arch: "arm64" },
  );
  return { dir, bundleRoot, settings, logDir: path.join(dir, "logs") };
}
const soon = () => Date.now() + 30_000;
const image = (settings) => vi.fn(async ({ outputDir }) => {
  const dmg = path.join(outputDir, settings.dmgName);
  fs.writeFileSync(dmg, "image");
  return dmg;
});

describe("runStep", () => {
  it("logs redacted output as it arrives and returns the complete output", async () => {
    const lines = [];
    const result = await runStep(
      process.execPath,
      ["-e", 'console.log("signing as SECRET-ID"); console.error("careful")'],
      { deadline: soon(), log: (line) => lines.push(line), redact: ["SECRET-ID"] },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("SECRET-ID");
    expect(lines[0]).toMatch(/^\$ .*-e console\.log/);
    expect(lines).toContain("stdout: signing as <redacted>");
    expect(lines).toContain("stderr: careful");
  });

  it("reports a failing command with its last stderr line unless tolerated", async () => {
    await expect(runStep(
      process.execPath,
      ["-e", 'console.error("first"); console.error("disk full"); process.exit(3)'],
      { deadline: soon() },
    )).rejects.toThrow(/release_dmg_step_failed: .* exited 3: disk full$/);
    const tolerated = await runStep(process.execPath, ["-e", "process.exit(2)"], { deadline: soon(), tolerateFailure: true });
    expect(tolerated.status).toBe(2);
    await expect(runStep("/nonexistent/dure-binary", [], { deadline: soon() })).rejects.toThrow("release_dmg_step_failed");
    await expect(runStep("true", [], { deadline: Date.now() - 1 })).rejects.toThrow("release_dmg_attempt_timeout: no time left");
  });

  it("kills the whole process group at the deadline", async () => {
    const marker = path.join(root("dure-dmg-pid-"), "grandchild");
    const lines = [];
    const program = `
      const { spawn } = require("node:child_process");
      const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
      require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(grandchild.pid));
      setTimeout(() => {}, 60000);`;
    const started = Date.now();
    await expect(runStep(process.execPath, ["-e", program], {
      deadline: Date.now() + 5_000,
      log: (line) => lines.push(line),
    })).rejects.toThrow("release_dmg_attempt_timeout");
    expect(Date.now() - started).toBeLessThan(25_000);
    expect(lines.some((line) => line.includes("terminating the process group"))).toBe(true);
    const grandchild = Number(fs.readFileSync(marker, "utf8"));
    expect(grandchild).toBeGreaterThan(0);
    await vi.waitFor(() => {
      expect(() => process.kill(grandchild, 0)).toThrow();
    }, { timeout: 10_000, interval: 200 });
  });
});

describe("createDiskImage", () => {
  function volume(dir, settings, { finderSaves = true } = {}) {
    const mount = path.join(dir, "mnt");
    const calls = [];
    const run = vi.fn(async (command, args, options) => {
      calls.push({ command, args, options });
      if (command === "du") return { status: 0, stdout: "2048\t/x\n" };
      if (command === "hdiutil" && args[0] === "attach") {
        fs.mkdirSync(mount);
        return { status: 0, stdout: "<plist/>" };
      }
      if (command === "/usr/bin/osascript") {
        if (finderSaves) fs.writeFileSync(path.join(mount, ".DS_Store"), "");
        return { status: 0, stdout: "" };
      }
      if (command === "plutil") {
        return { stdout: JSON.stringify({ "system-entities": [
          { "dev-entry": "/dev/disk9" },
          { "dev-entry": "/dev/disk9s1", "mount-point": mount },
        ] }) };
      }
      if (command === "hdiutil" && args[0] === "convert") {
        fs.writeFileSync(args.at(-1), "dmg");
        return { status: 0, stdout: "" };
      }
      return { status: 0, stdout: "" };
    });
    return { mount, calls, run, settings };
  }
  function styled(dir) {
    const tauriDir = path.join(dir, "src-tauri");
    fs.mkdirSync(path.join(tauriDir, "icons"), { recursive: true });
    fs.writeFileSync(path.join(tauriDir, "icons", "bg.tiff"), "tiff");
    fs.writeFileSync(path.join(tauriDir, "icons", "icon.icns"), "icns");
    return releaseDmgSettings(
      { productName: "Fixture", version: "1.2.3", bundle: { icon: ["icons/icon.icns"], macOS: { dmg: { background: "icons/bg.tiff" } } } },
      { tauriDir, arch: "arm64" },
    );
  }

  it("drives hdiutil, the Finder layout and codesign under one deadline, touching only the volume", async () => {
    const { dir, bundleRoot } = fixture();
    const { mount, calls, run, settings } = volume(dir, styled(dir));
    const identity = "Developer ID Application: Example (TEAM123456)";
    const deadline = Date.now() + 60_000;
    const outputDir = path.join(bundleRoot, "dmg");
    fs.mkdirSync(outputDir);
    const appPath = path.join(bundleRoot, "macos", "Fixture.app");
    const dmg = await createDiskImage({
      settings, appPath, outputDir, layout: true, deadline, log: () => {}, identity,
      mountRoot: "/Volumes", workRoot: dir, run,
    });
    expect(dmg).toBe(path.join(outputDir, "Fixture_1.2.3_aarch64.dmg"));
    expect(calls.map((call) => [call.command, call.args[0]])).toEqual([
      ["du", "-sk"],
      ["hdiutil", "create"],
      ["hdiutil", "attach"],
      ["plutil", "-convert"],
      ["SetFile", "-c"],
      ["/usr/bin/osascript", expect.stringMatching(/finder-layout\.applescript$/)],
      ["chmod", "-Rf"],
      ["SetFile", "-a"],
      ["hdiutil", "detach"],
      ["hdiutil", "convert"],
      ["codesign", "--force"],
      ["codesign", "--verify"],
    ]);
    expect(calls.every((call) => call.options.deadline === deadline)).toBe(true);
    const create = calls[1].args;
    expect(create.slice(0, 3)).toEqual(["create", "-srcfolder", appPath]);
    expect(create[create.indexOf("-size") + 1]).toBe("34m");
    expect(create[create.indexOf("-format") + 1]).toBe("UDRW");
    expect(calls[2].args).toEqual(expect.arrayContaining(["-mountrandom", "/Volumes", "-nobrowse", "-noautoopen", "-plist"]));
    expect(calls[5].args[1]).toBe("mnt");
    for (const index of [4, 6, 7]) expect(calls[index].options.tolerateFailure, calls[index].command).toBe(true);
    expect(calls[10].options.tolerateFailure).toBeUndefined();
    expect(calls[8].args).toEqual(["detach", "/dev/disk9s1"]);
    expect(calls[9].args).toEqual(expect.arrayContaining(["convert", "-format", "UDZO", "-imagekey", "zlib-level=9", "-o", dmg]));
    expect(calls[10].args).toEqual(["--force", "--sign", identity, "--timestamp", dmg]);
    expect(calls[10].options.redact).toEqual([identity]);
    expect(fs.readlinkSync(path.join(mount, "Applications"))).toBe("/Applications");
    expect(fs.readFileSync(path.join(mount, ".background", "bg.tiff"), "utf8")).toBe("tiff");
    expect(fs.readFileSync(path.join(mount, ".VolumeIcon.icns"), "utf8")).toBe("icns");
    expect(fs.readdirSync(appPath)).toEqual(["Contents"]);
    expect(fs.readdirSync(dir).filter((name) => name.startsWith("dure-dmg-"))).toEqual([]);
  }, 20_000);

  it("skips the layout and signing for a plain unsigned image", async () => {
    const { dir, bundleRoot } = fixture();
    const { calls, run, settings } = volume(dir, releaseDmgSettings({ productName: "Fixture", version: "1.2.3" }, { tauriDir: dir, arch: "arm64" }));
    const outputDir = path.join(bundleRoot, "dmg");
    fs.mkdirSync(outputDir);
    await createDiskImage({
      settings, appPath: path.join(bundleRoot, "macos", "Fixture.app"), outputDir, layout: false,
      deadline: soon(), log: () => {}, workRoot: dir, run,
    });
    expect(calls.map((call) => [call.command, call.args[0]])).toEqual([
      ["du", "-sk"], ["hdiutil", "create"], ["hdiutil", "attach"], ["plutil", "-convert"],
      ["chmod", "-Rf"], ["hdiutil", "detach"], ["hdiutil", "convert"],
    ]);
    // Without Finder the volume mounts privately, not under /Volumes.
    expect(calls[2].args[calls[2].args.indexOf("-mountrandom") + 1]).toMatch(/dure-dmg-/);
  });

  it("force-detaches the volume and removes a partial image when Finder never saves the layout", async () => {
    const { dir, bundleRoot } = fixture();
    const { calls, run, settings } = volume(dir, styled(dir), { finderSaves: false });
    const outputDir = path.join(bundleRoot, "dmg");
    fs.mkdirSync(outputDir);
    const lines = [];
    await expect(createDiskImage({
      settings, appPath: path.join(bundleRoot, "macos", "Fixture.app"), outputDir, layout: true,
      deadline: soon(), log: (line) => lines.push(line), mountRoot: "/Volumes", workRoot: dir, run,
      dsStoreWaitMs: 1_500,
    })).rejects.toThrow("release_dmg_layout_unsaved");
    expect(calls.at(-1).args).toEqual(["detach", "-force", "/dev/disk9s1"]);
    expect(calls.some((call) => call.command === "codesign" || call.args[0] === "convert")).toBe(false);
    expect(fs.readdirSync(outputDir)).toEqual([]);
    expect(fs.readdirSync(dir).filter((name) => name.startsWith("dure-dmg-"))).toEqual([]);
  }, 20_000);
});

describe("bundleReleaseDmg", () => {
  it("retries the Finder layout, then falls back to a plain image and keeps every attempt's log", async () => {
    const { bundleRoot, settings, logDir } = fixture();
    const create = vi.fn(async ({ layout, outputDir, log, deadline }) => {
      log(`layout=${layout}`);
      expect(deadline).toBeGreaterThan(Date.now());
      if (layout) throw new Error("release_dmg_step_failed: /usr/bin/osascript exited 1: Finder got an error: AppleEvent timed out");
      const dmg = path.join(outputDir, settings.dmgName);
      fs.writeFileSync(dmg, "image");
      return dmg;
    });
    const waitForHost = vi.fn(async () => ({ state: "ready" }));
    const echo = vi.fn();
    const result = await bundleReleaseDmg({
      settings, bundleRoot, layoutAttempts: 2, attemptTimeoutMs: 5_000, layoutWaitMs: 1_000, logDir, create, waitForHost, echo,
    });
    expect(result.mode).toBe("plain");
    expect(result.attempts.map((entry) => [entry.mode, entry.ok])).toEqual([["layout", false], ["layout", false], ["plain", true]]);
    expect(create.mock.calls.map(([options]) => [options.layout, options.mountRoot])).toEqual([[true, "/Volumes"], [true, "/Volumes"], [false, null]]);
    expect(waitForHost).toHaveBeenCalledTimes(2);
    expect(waitForHost.mock.calls[0][0]).toMatchObject({ maxWaitMs: 1_000, label: "DMG Finder layout" });
    expect(waitForHost.mock.calls[0][0].readPolicy()).toMatchObject({ enabled: true, maxLoadPerCore: 16, memoryPressureCeiling: "warning" });
    expect(fs.readdirSync(logDir).sort()).toEqual(["attempt-1-layout.log", "attempt-2-layout.log", "attempt-3-plain.log", "summary.json"]);
    expect(fs.readFileSync(path.join(logDir, "attempt-1-layout.log"), "utf8")).toMatch(/layout=true\n.*AppleEvent timed out/);
    expect(JSON.parse(fs.readFileSync(path.join(logDir, "summary.json"), "utf8"))).toMatchObject({
      ok: true, mode: "plain", dmgName: settings.dmgName,
      attempts: [{ attempt: 1, ok: false }, { attempt: 2, ok: false }, { attempt: 3, ok: true }],
    });
    expect(fs.readdirSync(path.join(bundleRoot, "dmg"))).toEqual([settings.dmgName]);
    expect(echo.mock.calls.some(([line]) => line.startsWith("[dmg 3/3 plain] packaged "))).toBe(true);
  });

  it("keeps the layout when the first attempt succeeds and tolerates a host wait that times out", async () => {
    const { bundleRoot, settings, logDir } = fixture();
    fs.mkdirSync(path.join(bundleRoot, "dmg"));
    fs.writeFileSync(path.join(bundleRoot, "dmg", "stale.dmg"), "old");
    const waitForHost = vi.fn(async () => {
      throw new Error("Host resource wait timed out; command was not started");
    });
    const result = await bundleReleaseDmg({
      settings, bundleRoot, layoutAttempts: 2, attemptTimeoutMs: 5_000, layoutWaitMs: 1_000, logDir,
      create: image(settings), waitForHost, echo: () => {},
    });
    expect(result.mode).toBe("layout");
    expect(result.attempts).toHaveLength(1);
    expect(fs.readdirSync(path.join(bundleRoot, "dmg"))).toEqual([settings.dmgName]);
    expect(fs.readFileSync(path.join(logDir, "attempt-1-layout.log"), "utf8")).toContain("attempting the layout anyway");
  });

  it("fails with every attempt's reason when the plain image also fails, and never waits for the plain attempt", async () => {
    const { bundleRoot, settings, logDir } = fixture();
    const create = vi.fn(async ({ layout }) => {
      throw new Error(layout ? "layout boom" : "hdiutil boom");
    });
    const waitForHost = vi.fn(async () => ({}));
    const options = { settings, bundleRoot, attemptTimeoutMs: 5_000, layoutWaitMs: 1_000, logDir, create, waitForHost, echo: () => {} };
    await expect(bundleReleaseDmg({ ...options, layoutAttempts: 1 })).rejects.toThrow(
      "release_dmg_bundle_failed: layout attempt 1: layout boom; plain attempt 2: hdiutil boom",
    );
    expect(waitForHost).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(path.join(logDir, "summary.json"), "utf8")).ok).toBe(false);
    await expect(bundleReleaseDmg({ ...options, layoutAttempts: 0 })).rejects.toThrow(
      "release_dmg_bundle_failed: plain attempt 1: hdiutil boom",
    );
    expect(waitForHost).toHaveBeenCalledTimes(1);
  });

  it("refuses to run without the built app or with invalid options", async () => {
    const { bundleRoot, settings, logDir } = fixture();
    await expect(bundleReleaseDmg({ settings, bundleRoot, logDir, layoutAttempts: -1, create: vi.fn() })).rejects.toThrow("release_dmg_option_invalid");
    await expect(bundleReleaseDmg({ settings, bundleRoot, logDir, attemptTimeoutMs: 0, create: vi.fn() })).rejects.toThrow("release_dmg_option_invalid");
    fs.rmSync(path.join(bundleRoot, "macos"), { recursive: true });
    await expect(bundleReleaseDmg({ settings, bundleRoot, logDir, create: vi.fn() })).rejects.toThrow("release_dmg_app_missing");
    expect(RELEASE_DMG_DEFAULTS).toEqual({ layoutAttempts: 2, attemptTimeoutSeconds: 240, layoutWaitSeconds: 180, dsStoreWaitSeconds: 60 });
  });

  it.skipIf(process.platform !== "darwin")("produces a compressed plain image from a fixture app with the real tools", async () => {
    const { dir, bundleRoot, settings, logDir } = fixture();
    const result = await bundleReleaseDmg({
      settings, bundleRoot, layoutAttempts: 0, attemptTimeoutMs: 55_000, logDir, workRoot: dir, echo: () => {},
    });
    expect(result.mode).toBe("plain");
    expect(path.basename(result.dmg)).toBe("Fixture_1.2.3_aarch64.dmg");
    expect(execFileSync("hdiutil", ["imageinfo", "-format", result.dmg], { encoding: "utf8" }).trim()).toBe("UDZO");
    expect(fs.readdirSync(path.join(bundleRoot, "dmg"))).toEqual([settings.dmgName]);
    expect(fs.readdirSync(dir).filter((name) => name.startsWith("dure-dmg-"))).toEqual([]);
  });
});
