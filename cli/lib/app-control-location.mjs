import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function appControlDirectory(environment = process.env) {
  const channel = environment.DURE_APP_CHANNEL ?? environment.HEBBIAN_APP_CHANNEL ?? "stable";
  if (!/^[a-z0-9-]{1,64}$/.test(channel)) throw new Error("Invalid Dure app channel.");
  const root = appRootDirectory(environment);
  return channel === "stable" ? root : join(root, "channels", channel);
}

export function appRootDirectory(environment = process.env) {
  return environment.DURE_HOME || join(homedir(), ".dure");
}

export function loadAppControlDescriptor(directory) {
  try { return JSON.parse(readFileSync(join(directory, "server.json"), "utf8")); }
  catch { return null; }
}
