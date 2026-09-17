import { describe, expect, test, vi } from "vitest";
import { createBoundedConcurrentTests } from "./bounded-concurrent-tests.mjs";

function fakeTestApi(registrations) {
  const testApi = (_name, callback) => registrations.push(callback);
  const concurrent = (_name, callback) => registrations.push(callback);
  concurrent.each = (cases) => (_name, callback) => {
    for (const arguments_ of cases) {
      registrations.push(() => callback(...arguments_));
    }
  };
  testApi.concurrent = concurrent;
  return testApi;
}

describe("bounded concurrent tests", () => {
  test("queues callbacks above the configured active limit", async () => {
    const registrations = [];
    const bounded = createBoundedConcurrentTests(
      fakeTestApi(registrations),
      2,
    );
    let active = 0;
    let peak = 0;
    const releases = [];
    for (let index = 0; index < 4; index += 1) {
      bounded.test(`fixture ${index}`, async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => releases.push(resolve));
        active -= 1;
      });
    }

    const running = registrations.map((callback) => callback());
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.shift()();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    while (releases.length > 0) releases.shift()();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases.shift()();
    await Promise.all(running);

    expect(peak).toBe(2);
    bounded.assertIdle();
  });

  test("rejects invalid limits", () => {
    expect(() => createBoundedConcurrentTests(fakeTestApi([]), 0)).toThrow(
      "positive integer",
    );
  });

  test("runs an exclusive callback after active work and before later work", async () => {
    const registrations = [];
    const bounded = createBoundedConcurrentTests(
      fakeTestApi(registrations),
      2,
    );
    const events = [];
    const releases = [];
    const register = (name, method = "test") => {
      bounded[method](name, async () => {
        events.push(`${name}:start`);
        await new Promise((resolve) => releases.push(resolve));
        events.push(`${name}:end`);
      });
    };
    register("normal-before");
    register("exclusive", "exclusiveTest");
    register("normal-after");

    const running = registrations.map((callback) => callback());
    await vi.waitFor(() =>
      expect(events).toEqual(["normal-before:start"]),
    );
    releases.shift()();
    await vi.waitFor(() =>
      expect(events).toEqual([
        "normal-before:start",
        "normal-before:end",
        "exclusive:start",
      ]),
    );
    releases.shift()();
    await vi.waitFor(() =>
      expect(events).toEqual([
        "normal-before:start",
        "normal-before:end",
        "exclusive:start",
        "exclusive:end",
        "normal-after:start",
      ]),
    );
    releases.shift()();
    await Promise.all(running);
    bounded.assertIdle();
  });

  test("runs owned cleanup when a callback fails", async () => {
    const registrations = [];
    const bounded = createBoundedConcurrentTests(
      fakeTestApi(registrations),
      1,
    );
    let cleaned = false;
    bounded.test("failing fixture", () => {
      bounded.deferCleanup(() => {
        cleaned = true;
      });
      throw new Error("fixture failed");
    });

    await expect(registrations[0]()).rejects.toThrow("fixture failed");
    expect(cleaned).toBe(true);
    bounded.assertIdle();
  });

  test("keeps owned cleanup without an internal admission queue", async () => {
    const registrations = [];
    const bounded = createBoundedConcurrentTests(
      fakeTestApi(registrations),
      1,
    );
    const events = [];
    bounded.sequentialTest("sequential fixture", () => {
      bounded.deferCleanup(() => events.push("cleanup"));
      events.push("body");
    });

    await registrations[0]();

    expect(events).toEqual(["body", "cleanup"]);
    bounded.assertIdle();
  });
});
