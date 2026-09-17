import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const read = (relativePath) =>
  fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
const json = (relativePath) => JSON.parse(read(relativePath));

describe("Linux desktop configuration boundary", () => {
  const common = json("src-tauri/tauri.conf.json");
  const linux = json("src-tauri/tauri.linux.conf.json");
  const macos = json("src-tauri/tauri.macos.conf.json");

  test("keeps macOS-only window behavior out of the common configuration", () => {
    const window = common.app.windows[0];
    expect(window).not.toHaveProperty("titleBarStyle");
    expect(window).not.toHaveProperty("hiddenTitle");
    expect(window).not.toHaveProperty("backgroundThrottling");
    expect(window).not.toHaveProperty("transparent");
    expect(common.bundle).not.toHaveProperty("targets");
  });

  test("preserves the shipped macOS bundle and window contract", () => {
    expect(macos.bundle.targets).toEqual(["app", "dmg"]);
    expect(macos.app.windows[0]).toMatchObject({
      titleBarStyle: "Overlay",
      hiddenTitle: true,
      backgroundThrottling: "disabled",
      transparent: true,
      dragDropEnabled: false,
    });
  });

  test("bounds the first Linux artifact set and defers updater publication", () => {
    expect(linux.bundle.targets).toEqual(["deb", "appimage"]);
    expect(linux.bundle.createUpdaterArtifacts).toBe(false);
  });

  // tauri-build validates raw Cargo commands against the common configuration
  // and dependency declaration; it does not merge the macOS overlay in that
  // path. Both inputs therefore stay common even though the implementation is
  // cfg-gated on macOS.
  test("keeps the raw Cargo feature contract aligned with Tauri config", () => {
    const cargo = read("src-tauri/Cargo.toml");
    const commonDependencies = cargo
      .split("\n[dependencies]\n")[1]
      .split("\n[")[0];
    const privateApiDependencies =
      cargo.match(
        /tauri = \{ version = "2", features = \["macos-private-api"\] \}/g,
      ) ?? [];
    const macosDependencies = cargo
      .split('\n[target.\'cfg(target_os = "macos")\'.dependencies]\n')[1]
      .split("\n[")[0];

    expect(common.app.macOSPrivateApi).toBe(true);
    expect(macos.app).not.toHaveProperty("macOSPrivateApi");
    expect(commonDependencies).toContain(
      'tauri = { version = "2", features = ["macos-private-api"] }',
    );
    expect(privateApiDependencies).toHaveLength(1);
    expect(macosDependencies).not.toContain("tauri =");
  });
});

describe("Linux desktop build gate", () => {
  const doctor = read("scripts/qa/linux-desktop-doctor.sh");

  test("checks the additional Secret Service and Tauri native dependencies", () => {
    for (const dependency of [
      "dbus-1",
      "gtk+-3.0",
      "webkit2gtk-4.1",
      "ayatana-appindicator3-0.1",
      "librsvg-2.0",
    ]) {
      expect(doctor).toContain(dependency);
    }
    expect(doctor).toContain("libdbus-1-dev");
    expect(doctor).toContain("libwebkit2gtk-4.1-dev");
  });
});
