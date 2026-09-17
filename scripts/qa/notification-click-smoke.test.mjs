import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { BUILD_STORAGE_RESERVATION_ENV } from "../lib/build-storage-reservation.mjs";
import {
  QA_BUNDLE_IDENTIFIER,
  QA_BUILD_ENV,
  QA_CONTROLLER_WINDOW_LABEL,
  QA_TARGET_WINDOW_LABEL,
  ambientLiveDescriptorPaths,
  buildQaTauriConfig,
  parseArguments,
  prepareQaIsolation,
  qaAppEnvironment,
  qaBuildEnvironment,
} from "./notification-click-smoke.mjs";

const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("signed notification click QA runner", () => {
  test("protects canonical and legacy live descriptors without giving legacy precedence", () => {
    expect(
      ambientLiveDescriptorPaths({
        HOME: "/Users/live",
        DURE_HOME: "/Users/live/custom-dure",
        DURE_APP_CHANNEL: "dev-canonical-a1b2c3d4",
        HEBBIAN_APP_CHANNEL: "dev-legacy-a1b2c3d4",
      }),
    ).toEqual([
      "/Users/live/.dure/channels/dev-canonical-a1b2c3d4/server.json",
      "/Users/live/custom-dure/channels/dev-canonical-a1b2c3d4/server.json",
      "/Users/live/.dure/channels/dev-legacy-a1b2c3d4/server.json",
      "/Users/live/custom-dure/channels/dev-legacy-a1b2c3d4/server.json",
    ]);
  });

  test("builds a dedicated identity with the release QA route", () => {
    const config = buildQaTauriConfig("/tmp/qa-isolation/Info.plist");
    expect(config.identifier).toBe(QA_BUNDLE_IDENTIFIER);
    expect(config.identifier).not.toBe("io.hebbian.ade");
    expect(QA_BUILD_ENV).toEqual({ VITE_DURE_NOTIFICATION_CLICK_QA: "1" });
    expect(config.app.windows).toHaveLength(2);
    expect(config.app.windows[0]).toMatchObject({
      label: QA_CONTROLLER_WINDOW_LABEL,
      url: "index.html?qaNotificationClick=1",
      visible: true,
    });
    expect(config.bundle).toMatchObject({
      targets: ["app"],
      createUpdaterArtifacts: false,
      macOS: { infoPlist: "/tmp/qa-isolation/Info.plist" },
    });
    expect(config.app.windows[1]).toMatchObject({
      label: QA_TARGET_WINDOW_LABEL,
      url: "index.html?qaNotificationClick=1&qaNotificationClickRole=target",
      visible: true,
      focus: false,
    });
  });

  test("passes the outer storage reservation through Tauri's nested frontend build", () => {
    expect(
      qaBuildEnvironment(
        { capability: "fixture-storage-capability" },
        { PATH: "/fixture/bin" },
      ),
    ).toEqual({
      [BUILD_STORAGE_RESERVATION_ENV]: "fixture-storage-capability",
      PATH: "/fixture/bin",
      ...QA_BUILD_ENV,
    });
  });

  test("replaces every live app identity with disposable exact paths", () => {
    const isolation = {
      root: "/tmp/dure-notification-click-qa-test",
      channel: "qa-notification-click-0123456789abcdef",
      home: "/tmp/dure-notification-click-qa-test/home",
      dureHome: "/tmp/dure-notification-click-qa-test/dure-home",
      discoveryRoot: "/tmp/dure-notification-click-qa-test/discovery",
      hebbianHome: "/tmp/dure-notification-click-qa-test/hebbian-home",
      cliInstallRoot: "/tmp/dure-notification-click-qa-test/cli/install",
      cliInstallDir: "/tmp/dure-notification-click-qa-test/cli/bin",
    };
    const environment = qaAppEnvironment(isolation, {
      HOME: "/Users/live",
      DURE_HOME: "/Users/live/.dure",
      DURE_APP_CHANNEL: "live",
      HEBBIAN_APP_CHANNEL: "live",
      VITE_DURE_APP_CHANNEL: "live",
      VITE_HEBBIAN_APP_CHANNEL: "live",
      DURE_DEV_PORT: "1437",
      HEBBIAN_DEV_PORT: "1420",
      HMUX_DISCOVERY_ROOT: "/Users/live/.hmux",
    });

    expect(environment).toMatchObject({
      HOME: isolation.home,
      DURE_HOME: isolation.dureHome,
      DURE_APP_CHANNEL: isolation.channel,
      VITE_DURE_APP_CHANNEL: isolation.channel,
      HMUX_DISCOVERY_ROOT: isolation.discoveryRoot,
    });
    expect(environment.HEBBIAN_APP_CHANNEL).toBeUndefined();
    expect(environment.VITE_HEBBIAN_APP_CHANNEL).toBeUndefined();
    expect(environment.DURE_DEV_PORT).toBeUndefined();
    expect(environment.HEBBIAN_DEV_PORT).toBeUndefined();
  });

  test("requires bounded explicit scenarios and opt-in authorization", () => {
    expect(
      parseArguments([
        "--",
        "--scenario",
        "cold-start",
        "--timeout",
        "30",
        "--authorize",
        "--require-execution",
      ]),
    ).toMatchObject({
      scenario: "cold-start",
      timeoutMs: 30_000,
      authorize: true,
      requireExecution: true,
    });
    expect(() => parseArguments(["--scenario", "unknown"])).toThrow(
      "unsupported scenario",
    );
    expect(() => parseArguments(["--timeout", "0"])).toThrow("--timeout");
  });

  test("rejects a reused isolation root whose child escapes through a symlink", () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "dure-notification-click-qa-test-")),
    );
    const outside = mkdtempSync(join(tmpdir(), "notification-click-outside-"));
    temporaryRoots.push(root, outside);
    mkdirSync(join(root, "dure-cli"), { mode: 0o700 });
    symlinkSync(outside, join(root, "home"));

    expect(() =>
      prepareQaIsolation(root, "qa-notification-click-0123456789abcdef"),
    ).toThrow("owner-only real directory");
  });
});
