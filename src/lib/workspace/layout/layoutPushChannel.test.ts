// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import {
  onLayoutPush,
  parseLayoutPush,
  projectPushedLayout,
  publishLayoutPush,
} from "@/lib/workspace/layout/layoutPushChannel";

describe("parseLayoutPush", () => {
  it("정상 push를 파싱한다", () => {
    const notice = parseLayoutPush(
      JSON.stringify({ desktopIds: ["d1", "d2"], at: 123, nonce: 0.5 }),
    );
    expect(notice).toEqual({ desktopIds: ["d1", "d2"], at: 123 });
  });

  it("손상 값·형식 불일치는 null", () => {
    expect(parseLayoutPush(null)).toBeNull();
    expect(parseLayoutPush("not json")).toBeNull();
    expect(parseLayoutPush(JSON.stringify({ desktopIds: [1], at: 2 }))).toBeNull();
    expect(parseLayoutPush(JSON.stringify({ desktopIds: ["d"] }))).toBeNull();
  });

  it("명시한 Dure backend projection만 현재 WebView에도 전달한다", () => {
    const received: unknown[] = [];
    const stop = onLayoutPush((notice) => received.push(notice));
    publishLayoutPush(["dure-space"], { localDelivery: true });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ desktopIds: ["dure-space"] });
    expect(() =>
      window.dispatchEvent(
        new CustomEvent("dure-layout-push", { detail: BigInt(1) }),
      ),
    ).not.toThrow();
    stop();
  });

  it("delegates a rejected durable rehydrate to the WebView recovery authority", async () => {
    const failure = new Error("rehydrate rejected");
    let observed: unknown;
    const recover = vi.fn(async (projection: () => Promise<void>) => {
      try {
        await projection();
      } catch (error) {
        observed = error;
      }
    });

    await expect(
      projectPushedLayout(
        () => Promise.reject(failure),
        () => true,
        recover,
      ),
    ).resolves.toBeUndefined();

    expect(recover).toHaveBeenCalledOnce();
    expect(observed).toBe(failure);
  });

  it("delegates a refused Dockview projection to the WebView recovery authority", async () => {
    let observed: unknown;
    const recover = vi.fn(async (projection: () => Promise<void>) => {
      try {
        await projection();
      } catch (error) {
        observed = error;
      }
    });

    await projectPushedLayout(
      () => Promise.resolve(),
      () => false,
      recover,
    );

    expect(observed).toBeInstanceOf(Error);
  });
});
