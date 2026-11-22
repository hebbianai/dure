import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function verifyPushSigning(info, entitlements, profile, now = Date.now()) {
  const environment = entitlements["aps-environment"];
  if (!["development", "production"].includes(environment)) {
    throw new Error("The signed iOS app has no Push Notifications entitlement");
  }
  if (info.DurePushEnvironment !== environment || profile.Entitlements?.["aps-environment"] !== environment) {
    throw new Error("The app, signature and provisioning profile must use the same APNs environment");
  }
  const team = entitlements["com.apple.developer.team-identifier"];
  const application = `${team}.${info.CFBundleIdentifier}`;
  if (!team || info.CFBundleIdentifier !== "dev.hebbian.ide.mobile" ||
      entitlements["application-identifier"] !== application ||
      profile.Entitlements?.["application-identifier"] !== application ||
      !profile.TeamIdentifier?.includes(team)) {
    throw new Error("Push signing must use the exact Dure App ID and one Apple team");
  }
  if (!(Date.parse(profile.ExpirationDate) > now)) {
    throw new Error("The push provisioning profile is expired or has no expiry");
  }
  return { bundleId: info.CFBundleIdentifier, teamId: team, environment };
}

/** The App Group the app shares with its notification service extension (`shared_config.rs`). */
export const APP_GROUP = "group.dev.hebbian.ide.mobile";
/** Where the app embeds the extension that names the agent in an alert (`alert_content.rs`). */
export const NOTIFICATION_SERVICE = "PlugIns/NotificationService.appex";

const sharesGroup = (entitlements) =>
  Array.isArray(entitlements?.["com.apple.security.application-groups"]) &&
  entitlements["com.apple.security.application-groups"].includes(APP_GROUP);

/**
 * The embedded notification service extension: the app's App ID with its
 * suffix, the app's version, and the App Group both share in every signature
 * and profile. Without the group the extension reads nothing and every alert
 * stays generic, so a build without it is refused rather than shipped quietly.
 */
export function verifyNotificationService(app, extension, now = Date.now()) {
  const team = app.entitlements["com.apple.developer.team-identifier"];
  const bundleId = `${app.info.CFBundleIdentifier}.NotificationService`;
  const applicationId = `${team}.${bundleId}`;
  if (extension.info.CFBundleIdentifier !== bundleId ||
      extension.info.NSExtension?.NSExtensionPointIdentifier !== "com.apple.usernotifications.service" ||
      extension.entitlements["application-identifier"] !== applicationId ||
      extension.profile.Entitlements?.["application-identifier"] !== applicationId ||
      !extension.profile.TeamIdentifier?.includes(team)) {
    throw new Error("The notification service extension must use its exact App ID under the app's team");
  }
  if (extension.info.CFBundleShortVersionString !== app.info.CFBundleShortVersionString ||
      extension.info.CFBundleVersion !== app.info.CFBundleVersion) {
    throw new Error("The notification service extension must carry the app's version");
  }
  if (![app.entitlements, app.profile.Entitlements, extension.entitlements, extension.profile.Entitlements].every(sharesGroup)) {
    throw new Error(`The app and its notification service extension must both be signed for ${APP_GROUP}`);
  }
  if (!(Date.parse(extension.profile.ExpirationDate) > now)) {
    throw new Error("The notification service provisioning profile is expired or has no expiry");
  }
  return { bundleId, appGroup: APP_GROUP };
}

function signedBundle(bundle) {
  const plist = (bytes) => JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", "-"], { input: bytes, encoding: "utf8" }));
  const info = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", path.join(bundle, "Info.plist")], { encoding: "utf8" }));
  const entitlements = plist(execFileSync("codesign", ["-d", "--entitlements", "-", "--xml", bundle], { stdio: ["ignore", "pipe", "pipe"] }));
  const profileBytes = execFileSync("security", ["cms", "-D", "-i", path.join(bundle, "embedded.mobileprovision")], { stdio: ["ignore", "pipe", "pipe"] });
  // Profiles contain dates and binary certificates that plutil cannot convert
  // to JSON. Project only the fields this check owns, without device IDs.
  const profile = JSON.parse(execFileSync("python3", ["-c", `
import json, plistlib, sys
value = plistlib.loads(sys.stdin.buffer.read())
print(json.dumps({key: value.get(key) for key in ("Entitlements", "TeamIdentifier", "ExpirationDate")}, default=lambda date: date.isoformat() + "Z"))
`], { input: profileBytes, encoding: "utf8" }));
  return { info, entitlements, profile };
}

export function verifyIosPushApplication(application) {
  const app = signedBundle(application);
  const push = verifyPushSigning(app.info, app.entitlements, app.profile);
  const notificationService = verifyNotificationService(app, signedBundle(path.join(application, NOTIFICATION_SERVICE)));
  return { ...push, notificationService };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (!process.argv[2]) throw new Error("Usage: node scripts/ios-push-signing.mjs /path/to/Dure.app");
    process.stdout.write(`${JSON.stringify(verifyIosPushApplication(process.argv[2]))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
