import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadTauriConfig,
  mergeTauriConfig,
  releaseDmgSettings,
  renderFinderLayoutScript,
} from "./release-dmg-settings.mjs";

const roots = [];
function root() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dure-dmg-settings-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const base = {
  productName: "Dure",
  version: "0.2.56",
  bundle: {
    icon: ["icons/32x32.png", "icons/icon.icns"],
    macOS: {
      dmg: {
        background: "icons/dmg-background.tiff",
        windowSize: { width: 680, height: 420 },
        appPosition: { x: 180, y: 200 },
        applicationFolderPosition: { x: 500, y: 200 },
      },
    },
  },
};
const at = (tauriDir, arch = "arm64") => ({ tauriDir, arch });

describe("release DMG settings", () => {
  it("layers the platform file and --config files as JSON merge patches", () => {
    const dir = root();
    const write = (name, value) => {
      fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
      return path.join(dir, name);
    };
    write("tauri.conf.json", {
      productName: "Dure", version: "0.2.56",
      bundle: { targets: ["app"], macOS: { dmg: { appPosition: { x: 1, y: 1 } } } },
      plugins: { updater: { endpoints: ["a"] } },
    });
    write("tauri.macos.conf.json", {
      bundle: { targets: ["app", "dmg"], macOS: { dmg: { windowSize: { width: 680, height: 420 } } } },
    });
    const beta = write("beta.json", {
      plugins: { updater: { endpoints: ["b"] } },
      bundle: { macOS: { dmg: { appPosition: null } } },
    });
    const config = loadTauriConfig(dir, [beta]);
    expect(config.bundle.targets).toEqual(["app", "dmg"]);
    expect(config.bundle.macOS.dmg).toEqual({ windowSize: { width: 680, height: 420 } });
    expect(config.plugins.updater.endpoints).toEqual(["b"]);
    expect(mergeTauriConfig({ a: { b: 1, c: 2 } }, { a: { b: null, d: 3 } })).toEqual({ a: { c: 2, d: 3 } });
    expect(() => loadTauriConfig(dir, [path.join(dir, "missing.json")])).toThrow("release_dmg_config_unreadable");
  });

  it("derives tauri-bundler's names, files and layout, with its defaults", () => {
    expect(releaseDmgSettings(base, at("/repo/src-tauri"))).toEqual({
      productName: "Dure",
      version: "0.2.56",
      arch: "aarch64",
      appName: "Dure.app",
      dmgName: "Dure_0.2.56_aarch64.dmg",
      volumeName: "Dure",
      background: "/repo/src-tauri/icons/dmg-background.tiff",
      volumeIcon: "/repo/src-tauri/icons/icon.icns",
      windowPosition: { x: 10, y: 60 },
      windowSize: { width: 680, height: 420 },
      appPosition: { x: 180, y: 200 },
      applicationFolderPosition: { x: 500, y: 200 },
    });
    expect(releaseDmgSettings({ productName: "Dure", version: "1.0.0-beta.1" }, at("/r", "x64"))).toMatchObject({
      dmgName: "Dure_1.0.0-beta.1_x64.dmg",
      background: null,
      volumeIcon: null,
      windowSize: { width: 660, height: 400 },
      appPosition: { x: 180, y: 170 },
      applicationFolderPosition: { x: 480, y: 170 },
    });
  });

  it("matches the committed configuration the release build uses", () => {
    const settings = releaseDmgSettings(
      loadTauriConfig("src-tauri", ["src-tauri/tauri.beta.conf.json"]),
      at("src-tauri"),
    );
    const { version } = JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json", "utf8"));
    expect(settings.dmgName).toBe(`Dure_${version}_aarch64.dmg`);
    expect(settings.appName).toBe("Dure.app");
    expect(fs.existsSync(settings.background)).toBe(true);
    expect(fs.existsSync(settings.volumeIcon)).toBe(true);
    expect(settings.windowSize).toEqual({ width: 680, height: 420 });
  });

  it("refuses configurations the packager would misrepresent", () => {
    for (const [patch, code] of [
      [{ version: "../package.json" }, "release_dmg_version_unsupported"],
      [{ productName: "Du/re" }, "release_dmg_product_name_invalid"],
      [{ bundle: { licenseFile: "LICENSE" } }, "release_dmg_license_unsupported"],
      [{ bundle: { macOS: { dmg: { appPosition: { x: 1.5, y: 2 } } } } }, "release_dmg_layout_invalid"],
      [{ bundle: { macOS: { dmg: { windowSize: { width: -1, height: 400 } } } } }, "release_dmg_layout_invalid"],
      [{ bundle: { macOS: { dmg: { windowSize: { height: null } } } } }, "release_dmg_layout_invalid"],
      [{ bundle: { macOS: { dmg: { background: 7 } } } }, "release_dmg_layout_invalid"],
    ]) {
      expect(() => releaseDmgSettings(mergeTauriConfig(base, patch), at("/r"))).toThrow(code);
    }
    expect(() => releaseDmgSettings(base, at("/r", "ia32"))).toThrow("release_dmg_arch_unsupported");
  });

  it("renders the Finder layout as a self-terminating script", () => {
    const script = renderFinderLayoutScript(releaseDmgSettings(base, at("/r")));
    expect(script).toContain('set background picture of opts to file ".background:dmg-background.tiff"');
    expect(script).toContain("set position of every item to {theBottomRightX + 100, 100}");
    expect(script).toContain('set position of item "Dure.app" to {180, 200}');
    expect(script).toContain('set the extension hidden of item "Dure.app" to true');
    expect(script).toContain('set position of item "Applications" to {500, 200}');
    expect(script).toContain("set theBottomRightX to 690");
    expect(script).toContain("set theBottomRightY to 480");
    expect(script).toContain("set icon size to 128");
    // The unbounded .DS_Store wait of the bundler's template is the caller's job.
    expect(script).not.toMatch(/repeat|do shell script/);
    expect(script.trimEnd().endsWith("end run")).toBe(true);
    const plain = renderFinderLayoutScript(releaseDmgSettings({ productName: "Dure", version: "1.0.0" }, at("/r")));
    expect(plain).not.toContain("background picture");
    expect(plain).not.toContain("every item");
    expect(plain).toContain('set position of item "Dure.app" to {180, 170}');
  });

  it.skipIf(process.platform !== "darwin")("compiles as AppleScript without contacting Finder", () => {
    const dir = root();
    const source = path.join(dir, "layout.applescript");
    fs.writeFileSync(source, renderFinderLayoutScript(releaseDmgSettings(base, at("/r"))));
    execFileSync("osacompile", ["-o", path.join(dir, "layout.scpt"), source], { stdio: "pipe" });
    expect(fs.statSync(path.join(dir, "layout.scpt")).size).toBeGreaterThan(0);
  });
});
