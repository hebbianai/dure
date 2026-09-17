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

export function verifyIosPushApplication(application) {
  const plist = (bytes) => JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", "-"], { input: bytes, encoding: "utf8" }));
  const info = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", path.join(application, "Info.plist")], { encoding: "utf8" }));
  const entitlements = plist(execFileSync("codesign", ["-d", "--entitlements", "-", "--xml", application], { stdio: ["ignore", "pipe", "pipe"] }));
  const profileBytes = execFileSync("security", ["cms", "-D", "-i", path.join(application, "embedded.mobileprovision")], { stdio: ["ignore", "pipe", "pipe"] });
  // Profiles contain dates and binary certificates that plutil cannot convert
  // to JSON. Project only the fields this check owns, without device IDs.
  const profile = JSON.parse(execFileSync("python3", ["-c", `
import json, plistlib, sys
value = plistlib.loads(sys.stdin.buffer.read())
print(json.dumps({key: value.get(key) for key in ("Entitlements", "TeamIdentifier", "ExpirationDate")}, default=lambda date: date.isoformat() + "Z"))
`], { input: profileBytes, encoding: "utf8" }));
  return verifyPushSigning(info, entitlements, profile);
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
