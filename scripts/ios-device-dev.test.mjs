import assert from "node:assert/strict";
import { test } from "vitest";
import { builtApplication, selectPhysicalDevice, scrubTauriEnvironment } from "./ios-device-dev.mjs";

test("selects the only available physical iPhone", () => {
  const selected = selectPhysicalDevice([
    {
      name: "Simulator",
      identifier: "sim",
      platform: "com.apple.platform.iphonesimulator",
      available: true,
      simulator: true,
    },
    {
      name: "Old phone",
      identifier: "old",
      platform: "com.apple.platform.iphoneos",
      available: false,
      simulator: false,
    },
    {
      name: "Phone",
      identifier: "device-1",
      platform: "com.apple.platform.iphoneos",
      available: true,
      simulator: false,
    },
  ]);

  assert.equal(selected.identifier, "device-1");
});

test("removes desktop Tauri configuration from the mobile build", () => {
  const clean = scrubTauriEnvironment({
    PATH: "/bin",
    TAURI_CONFIG: '{"identifier":"desktop"}',
    TAURI_ENV_TARGET_TRIPLE: "aarch64-apple-darwin",
  });

  assert.deepEqual(clean, { PATH: "/bin" });
});

test("finds the archive's one app bundle whatever productName calls it", () => {
  assert.equal(
    builtApplication("/archive/Products/Applications", ["Dure.app", ".DS_Store"]),
    "/archive/Products/Applications/Dure.app",
  );
  assert.throws(
    () => builtApplication("/archive/Products/Applications", []),
    /found 0: none/,
  );
  assert.throws(
    () => builtApplication("/archive/Products/Applications", ["A.app", "B.app"]),
    /found 2: A.app, B.app/,
  );
});
