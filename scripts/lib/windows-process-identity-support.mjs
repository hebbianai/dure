import { spawn } from "node:child_process";
import { observeProcessIdentity } from "./process-identity.mjs";
import { parseWindowsProcessIdentity } from "./windows-process-identity.mjs";

const SUPPORT_TIMEOUT_MS = 10_000;

function unavailable(message) {
  const error = new Error(message);
  error.code = "DEV_PROCESS_IDENTITY_UNAVAILABLE";
  return error;
}

async function waitForIdentity(pid, expectedIdentity) {
  const deadline = Date.now() + SUPPORT_TIMEOUT_MS;
  do {
    const identity = await observeProcessIdentity(pid, {
      platform: "win32",
      timeoutMs: Math.max(1, deadline - Date.now()),
    });
    if (identity && expectedIdentity === undefined) return identity;
    if (identity === expectedIdentity) return identity;
    if (identity && expectedIdentity !== undefined) {
      throw unavailable("Windows process generation changed during admission");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  throw unavailable("Windows process identity is unavailable");
}

export async function requireWindowsProcessIdentitySupport(
  platform = process.platform,
) {
  if (platform !== "win32") {
    throw unavailable("Windows identity admission requires native Windows");
  }
  const currentIdentity = await waitForIdentity(process.pid);
  if (parseWindowsProcessIdentity(currentIdentity)?.pid !== process.pid) {
    throw unavailable("current Windows identity is invalid");
  }
  await waitForIdentity(process.pid, currentIdentity);

  const child = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { stdio: "ignore", windowsHide: true },
  );
  const closed = new Promise((resolve) => child.once("close", resolve));
  let childIdentity;
  try {
    if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
      throw unavailable("Windows identity probe did not start");
    }
    childIdentity = await waitForIdentity(child.pid);
    if (parseWindowsProcessIdentity(childIdentity)?.pid !== child.pid) {
      throw unavailable("child Windows identity is invalid");
    }
    await waitForIdentity(child.pid, childIdentity);
  } finally {
    child.kill();
    await closed;
  }
  return Object.freeze({
    child: Object.freeze({ pid: child.pid, processIdentity: childIdentity }),
    current: Object.freeze({
      pid: process.pid,
      processIdentity: currentIdentity,
    }),
  });
}
