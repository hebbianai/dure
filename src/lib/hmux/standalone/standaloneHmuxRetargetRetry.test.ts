import { describe, expect, it, vi } from "vitest";
import { StandaloneHmuxRetargetRetryCoordinator } from "@/lib/hmux/standalone/standaloneHmuxRetargetRetry";

describe("StandaloneHmuxRetargetRetryCoordinator", () => {
  it("deduplicates repeated delivery and converges after transient failures", async () => {
    let attempts = 0;
    const sleep = vi.fn(async () => {});
    const coordinator = new StandaloneHmuxRetargetRetryCoordinator({
      delaysMs: [0, 25, 50, 100, 200],
      sleep,
    });
    const attempt = vi.fn(async () => {
      attempts += 1;
      return attempts === 5;
    });

    const results = Array.from({ length: 20 }, () =>
      coordinator.run("operation-1", "canonical-payload", attempt),
    );

    await expect(Promise.all(results)).resolves.toEqual(
      Array.from({ length: 20 }, () => true),
    );
    expect(attempt).toHaveBeenCalledTimes(5);
    expect(sleep).toHaveBeenCalledTimes(4);
    expect(coordinator.activeOwnerCount()).toBe(0);
  });

  it("fails closed for an operation id reused with a different payload", async () => {
    let release!: (value: boolean) => void;
    const pending = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const coordinator = new StandaloneHmuxRetargetRetryCoordinator({
      delaysMs: [0],
    });

    const original = coordinator.run(
      "operation-1",
      "payload-a",
      () => pending,
    );
    await Promise.resolve();
    await expect(
      coordinator.run("operation-1", "payload-b", async () => true),
    ).resolves.toBe(false);
    release(true);
    await expect(original).resolves.toBe(true);
    expect(coordinator.activeOwnerCount()).toBe(0);
  });

  it("bounds permanent failures and releases its owner", async () => {
    const coordinator = new StandaloneHmuxRetargetRetryCoordinator({
      delaysMs: [0, 25, 50],
      sleep: async () => {},
    });
    const attempt = vi.fn(async () => false);

    await expect(
      coordinator.run("operation-1", "payload", attempt),
    ).resolves.toBe(false);
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(coordinator.activeOwnerCount()).toBe(0);
  });

  it("caps concurrent owners", async () => {
    let release!: (value: boolean) => void;
    const pending = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const coordinator = new StandaloneHmuxRetargetRetryCoordinator({
      delaysMs: [0],
      maxOwners: 1,
    });

    const first = coordinator.run("operation-1", "payload-1", () => pending);
    await Promise.resolve();
    await expect(
      coordinator.run("operation-2", "payload-2", async () => true),
    ).resolves.toBe(false);
    expect(coordinator.activeOwnerCount()).toBe(1);
    release(true);
    await first;
    expect(coordinator.activeOwnerCount()).toBe(0);
  });
});
