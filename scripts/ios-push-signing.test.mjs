import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { APP_GROUP, verifyNotificationService, verifyPushSigning } from "./ios-push-signing.mjs";

const info = { CFBundleIdentifier: "dev.hebbian.ide.mobile", DurePushEnvironment: "development" };
const entitlements = {
  "aps-environment": "development",
  "com.apple.developer.team-identifier": "TESTTEAM12",
  "application-identifier": "TESTTEAM12.dev.hebbian.ide.mobile",
};
const profile = {
  TeamIdentifier: ["TESTTEAM12"],
  Entitlements: entitlements,
  ExpirationDate: "2030-01-01T00:00:00Z",
};

test("a matching explicit App ID, environment, team and unexpired profile meet signing prerequisites", () => {
  assert.equal(verifyPushSigning(info, entitlements, profile, 0).environment, "development");
});

test("exporting a development build with a production APNs signature is refused", () => {
  const production = { ...entitlements, "aps-environment": "production" };
  assert.throws(() => verifyPushSigning(info, production, { ...profile, Entitlements: production }, 0), /same APNs environment/);
  assert.equal(verifyPushSigning({ ...info, DurePushEnvironment: "production" }, production, { ...profile, Entitlements: production }, 0).environment, "production");
});

test("a wildcard App ID, missing capability, different team or expired profile cannot claim push readiness", () => {
  assert.throws(() => verifyPushSigning(info, { ...entitlements, "aps-environment": undefined }, profile, 0), /no Push/);
  assert.throws(() => verifyPushSigning(info, entitlements, { ...profile, Entitlements: { ...entitlements, "application-identifier": "TESTTEAM12.*" } }, 0), /exact Dure App ID/);
  assert.throws(() => verifyPushSigning(info, entitlements, { ...profile, TeamIdentifier: ["OTHERTEAM1"] }, 0), /one Apple team/);
  assert.throws(() => verifyPushSigning(info, entitlements, profile, Date.parse("2031-01-01")), /expired/);
});

const groups = { "com.apple.security.application-groups": [APP_GROUP] };
const signedApp = {
  info: { ...info, CFBundleShortVersionString: "0.1.8", CFBundleVersion: "8" },
  entitlements: { ...entitlements, ...groups },
  profile: { ...profile, Entitlements: { ...entitlements, ...groups } },
};
const extensionEntitlements = {
  "com.apple.developer.team-identifier": "TESTTEAM12",
  "application-identifier": "TESTTEAM12.dev.hebbian.ide.mobile.NotificationService",
  ...groups,
};
const signedExtension = {
  info: {
    CFBundleIdentifier: "dev.hebbian.ide.mobile.NotificationService",
    CFBundleShortVersionString: "0.1.8",
    CFBundleVersion: "8",
    NSExtension: { NSExtensionPointIdentifier: "com.apple.usernotifications.service" },
  },
  entitlements: extensionEntitlements,
  profile: { TeamIdentifier: ["TESTTEAM12"], Entitlements: extensionEntitlements, ExpirationDate: "2030-01-01T00:00:00Z" },
};

test("the embedded notification service shares the app's group, version and team", () => {
  assert.deepEqual(verifyNotificationService(signedApp, signedExtension, 0), {
    bundleId: "dev.hebbian.ide.mobile.NotificationService",
    appGroup: APP_GROUP,
  });
});

test("an extension without the shared group, the app's version or its own App ID is refused", () => {
  const without = ({ "com.apple.security.application-groups": _, ...rest }) => rest;
  assert.throws(() => verifyNotificationService(signedApp, { ...signedExtension, entitlements: without(extensionEntitlements) }, 0), /both be signed for/);
  assert.throws(() => verifyNotificationService({ ...signedApp, profile: profile }, signedExtension, 0), /both be signed for/);
  assert.throws(() => verifyNotificationService(signedApp, { ...signedExtension, info: { ...signedExtension.info, CFBundleVersion: "7" } }, 0), /app's version/);
  assert.throws(() => verifyNotificationService(signedApp, { ...signedExtension, info: { ...signedExtension.info, CFBundleIdentifier: "dev.hebbian.ide.mobile" } }, 0), /exact App ID/);
  assert.throws(() => verifyNotificationService(signedApp, signedExtension, Date.parse("2031-01-01")), /expired/);
});

/** A version bump that misses the extension is caught here, not at upload. */
test("the notification service carries the app's version in the checked-in sources", () => {
  const apple = path.join(path.dirname(fileURLToPath(import.meta.url)), "../mobile/src-tauri/gen/apple");
  const versions = (file) => {
    const text = readFileSync(path.join(apple, file), "utf8");
    const value = (key) => text.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`))?.[1];
    return [value("CFBundleShortVersionString"), value("CFBundleVersion")];
  };
  const tauri = JSON.parse(readFileSync(path.join(apple, "../../tauri.conf.json"), "utf8"));
  const app = versions("dure-mobile_iOS/Info.plist");
  assert.deepEqual(app, [tauri.version, tauri.bundle.iOS.bundleVersion]);
  assert.deepEqual(versions("NotificationService/Info.plist"), app);
  const project = readFileSync(path.join(apple, "project.yml"), "utf8");
  assert.equal(project.match(/CFBundleShortVersionString: (\S+)/g)?.length, 2);
  for (const line of project.match(/CFBundleShortVersionString: (\S+)/g)) assert.equal(line.split(": ")[1], app[0]);
  for (const line of project.match(/CFBundleVersion: "?(\d+)"?/g)) assert.equal(line.split(": ")[1].replaceAll('"', ""), app[1]);
});
