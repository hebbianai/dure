import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import {
  observeProcessIdentity,
  signalProcessGeneration,
  signalProcessGenerationSync,
} from "./process-identity.mjs";

const DIFFERENT_BOOT_SESSION = "00000000-0000-0000-0000-000000000000";
const signalers = [
  ["async", (owner) => signalProcessGeneration(owner, "SIGCONT")],
  [
    "sync",
    (owner) => Promise.resolve().then(
      () => signalProcessGenerationSync(owner, "SIGCONT"),
    ),
  ],
];

it("rejects a nonpositive async signal timeout before invoking the boundary", async () => {
  await expect(
    signalProcessGeneration(
      { pid: process.pid, processIdentity: "fixture" },
      "SIGCONT",
      { timeoutMs: 0 },
    ),
  ).rejects.toThrow("process signal timeout must be positive");
});

async function currentMacosGeneration() {
  const observed = await observeProcessIdentity(process.pid, {
    platform: "darwin",
  });
  const uniqueId = observed?.match(/(\d+)$/u)?.[1];
  if (!uniqueId) throw new Error("macOS process identity was unavailable");
  const bootSession = execFileSync(
    "sysctl",
    ["-n", "kern.bootsessionuuid"],
    { encoding: "utf8" },
  ).trim().toLowerCase();
  return { bootSession, uniqueId };
}

it.runIf(process.platform === "darwin").each(signalers)(
  "%s rejects a legacy boot-local macOS generation",
  async (_mode, signal) => {
    const { uniqueId } = await currentMacosGeneration();
    await expect(
      signal({
        pid: process.pid,
        processIdentity: `kernel-start-v2:macos:${uniqueId}`,
      }),
    ).rejects.toMatchObject({
      code: "DEV_PROCESS_IDENTITY_UNAVAILABLE",
      message: "invalid macOS process identity",
    });
  },
);

it.runIf(process.platform === "darwin").each(signalers)(
  "%s rejects the same macOS pid and unique id from another boot",
  async (_mode, signal) => {
    const { bootSession, uniqueId } = await currentMacosGeneration();
    const otherBootSession = bootSession === DIFFERENT_BOOT_SESSION
      ? "ffffffff-ffff-ffff-ffff-ffffffffffff"
      : DIFFERENT_BOOT_SESSION;
    await expect(
      signal({
        pid: process.pid,
        processIdentity:
          `kernel-start-v3:macos:${otherBootSession}:${uniqueId}`,
      }),
    ).rejects.toMatchObject({ code: "DEV_PROCESS_IDENTITY_UNAVAILABLE" });
  },
);

it.runIf(process.platform === "darwin").each(signalers)(
  "%s observes and signals a same-boot macOS generation",
  async (_mode, signal) => {
    const { bootSession, uniqueId } = await currentMacosGeneration();
    const processIdentity =
      `kernel-start-v3:macos:${bootSession}:${uniqueId}`;
    await expect(
      signal({ pid: process.pid, processIdentity }),
    ).resolves.toBe(true);
    await expect(observeProcessIdentity(process.pid, { platform: "darwin" }))
      .resolves.toBe(processIdentity);
  },
);
