import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireDevDeployLock,
  createDevDeployLockProbe,
  devDeployLockAuthorizes,
  devDeployHmrStatusReady,
  parseDevDeployLock,
  readActiveDevDeployLock,
} from "./dev-deploy-lock.mjs";

let directory;
let pathname;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "dev-deploy-lock-"));
  pathname = join(directory, "dev-deploy.lock");
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function acquire(overrides = {}) {
  return acquireDevDeployLock({
    pathname,
    worktreeRoot: "/workspace/live",
    channel: "dev-live-1234567890",
    suppressHmr: true,
    ...overrides,
  });
}

describe("dev deploy lock", () => {
  it("publishes one exact owner and releases only that generation", () => {
    const lease = acquire();
    expect(lease).not.toBeNull();
    expect(parseDevDeployLock(readFileSync(pathname, "utf8"))).toEqual(
      lease.record,
    );
    expect(acquire()).toBeNull();
    expect(lease.release()).toBe(true);
  });

  it("is an HMR fence only for its exact live worktree and channel", () => {
    const lease = acquire();
    const active = readActiveDevDeployLock({
      pathname,
      worktreeRoot: "/workspace/live",
      channel: "dev-live-1234567890",
    });
    expect(active?.generation).toBe(lease.record.generation);
    expect(
      readActiveDevDeployLock({
        pathname,
        worktreeRoot: "/workspace/other",
        channel: "dev-live-1234567890",
      }),
    ).toBeNull();
    expect(
      readActiveDevDeployLock({
        pathname,
        worktreeRoot: "/workspace/live",
        channel: "dev-other-1234567890",
      }),
    ).toBeNull();
    lease.release();
  });

  it("does not fence HMR for a non-coordinated deploy", () => {
    const lease = acquire({ suppressHmr: false });
    expect(
      readActiveDevDeployLock({
        pathname,
        worktreeRoot: "/workspace/live",
        channel: "dev-live-1234567890",
      }),
    ).toBeNull();
    lease.release();
  });

  it("rejects a stale exact process generation", () => {
    const lease = acquire();
    expect(
      readActiveDevDeployLock({
        pathname,
        worktreeRoot: "/workspace/live",
        channel: "dev-live-1234567890",
        alive: () => true,
        identity: () => "different-generation",
      }),
    ).toBeNull();
    lease.release();
  });

  it("authenticates status reads with the lock capability", () => {
    const lease = acquire();
    expect(
      devDeployLockAuthorizes(lease.record, `Bearer ${lease.record.token}`),
    ).toBe(true);
    expect(devDeployLockAuthorizes(lease.record, "Bearer wrong")).toBe(false);
    lease.release();
  });

  it("caches one active probe across a filesystem event burst", () => {
    const lease = acquire();
    let reads = 0;
    const probe = createDevDeployLockProbe(
      {
        pathname,
        worktreeRoot: "/workspace/live",
        channel: "dev-live-1234567890",
        alive: () => true,
        identity: () => {
          reads += 1;
          return lease.record.processIdentity;
        },
      },
      100,
    );
    expect(probe({ nowMs: 1_000 })).not.toBeNull();
    expect(probe({ nowMs: 1_050 })).not.toBeNull();
    expect(reads).toBe(1);
    lease.release();
  });

  it("requires the exact fenced generation to be quiet after the head move", () => {
    const lease = acquire();
    const status = {
      schemaVersion: 1,
      fenced: true,
      generation: lease.record.generation,
      observedAtUnixMs: 2_000,
      lastSuppressedAtUnixMs: 1_700,
    };
    expect(
      devDeployHmrStatusReady(status, lease.record, {
        deployedAtMs: 1_000,
        nowMs: 2_000,
      }),
    ).toBe(false);
    expect(
      devDeployHmrStatusReady(status, lease.record, {
        deployedAtMs: 1_000,
        nowMs: 2_200,
      }),
    ).toBe(true);
    expect(
      devDeployHmrStatusReady(
        { ...status, generation: "another-generation" },
        lease.record,
        { deployedAtMs: 1_000, nowMs: 2_200 },
      ),
    ).toBe(false);
    lease.release();
  });

  it("keeps the lock owner-only", () => {
    const lease = acquire();
    expect(lstatSync(pathname).mode & 0o077).toBe(0);
    lease.release();
  });

  it("does not release a replacement generation", () => {
    const lease = acquire();
    const replacement = { ...lease.record, generation: "replacement" };
    writeFileSync(pathname, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
    expect(lease.release()).toBe(false);
    expect(parseDevDeployLock(readFileSync(pathname, "utf8")).generation).toBe(
      "replacement",
    );
  });

  it("reclaims a malformed reservation only after its publication grace", () => {
    writeFileSync(pathname, "", { mode: 0o600 });
    expect(acquire()).toBeNull();
    utimesSync(pathname, new Date(0), new Date(0));
    const lease = acquire({ nowMs: 10_000 });
    expect(lease).not.toBeNull();
    lease.release();
  });
});
