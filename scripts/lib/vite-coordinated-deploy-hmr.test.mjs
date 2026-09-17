import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireDevDeployLock,
  DEV_DEPLOY_HMR_STATUS_PATH,
} from "./dev-deploy-lock.mjs";
import { createCoordinatedDeployHmrPlugin } from "./vite-coordinated-deploy-hmr.mjs";

let directory;
let pathname;
let lease;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "vite-deploy-hmr-"));
  pathname = join(directory, "dev-deploy.lock");
  lease = acquireDevDeployLock({
    pathname,
    worktreeRoot: "/workspace/live",
    channel: "dev-live-1234567890",
    suppressHmr: true,
  });
});

afterEach(() => {
  lease?.release();
  rmSync(directory, { recursive: true, force: true });
});

function middlewareFor(plugin) {
  let route;
  let handler;
  plugin.configureServer({
    middlewares: {
      use(nextRoute, nextHandler) {
        route = nextRoute;
        handler = nextHandler;
      },
    },
  });
  expect(route).toBe(DEV_DEPLOY_HMR_STATUS_PATH);
  return handler;
}

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(value = "") {
      this.body = value;
    },
  };
}

function hotUpdate(plugin, { modules = [], timestamp = Date.now() } = {}) {
  return plugin.hotUpdate.call(
    {
      environment: {
        moduleGraph: { invalidateModule() {} },
      },
    },
    { modules, timestamp },
  );
}

describe("coordinated Vite deploy HMR", () => {
  it("buffers the exact deploy event burst and reports its quiet boundary", () => {
    let nowMs = 10_000;
    const plugin = createCoordinatedDeployHmrPlugin({
      pathname,
      worktreeRoot: "/workspace/live",
      channel: "dev-live-1234567890",
      now: () => nowMs,
    });
    expect(hotUpdate(plugin, { timestamp: nowMs })).toEqual([]);
    nowMs = 10_100;
    expect(hotUpdate(plugin, { timestamp: nowMs })).toEqual([]);

    const handler = middlewareFor(plugin);
    const res = response();
    handler(
      { headers: { authorization: `Bearer ${lease.record.token}` } },
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      fenced: true,
      generation: lease.record.generation,
      suppressedCount: 2,
      lastSuppressedAtUnixMs: 10_100,
    });
  });

  it("invalidates fenced modules without emitting ordinary HMR updates", () => {
    const plugin = createCoordinatedDeployHmrPlugin({
      pathname,
      worktreeRoot: "/workspace/live",
      channel: "dev-live-1234567890",
    });
    const invalidateModule = vi.fn();
    const modules = [{ id: "/src/main.tsx" }, { id: "/src/App.tsx" }];
    const context = {
      environment: { moduleGraph: { invalidateModule } },
    };

    expect(
      plugin.hotUpdate.call(context, { modules, timestamp: 12_345 }),
    ).toEqual([]);
    expect(invalidateModule).toHaveBeenCalledTimes(2);
    expect(invalidateModule).toHaveBeenNthCalledWith(
      1,
      modules[0],
      expect.any(Set),
      12_345,
      true,
    );
    expect(invalidateModule).toHaveBeenNthCalledWith(
      2,
      modules[1],
      expect.any(Set),
      12_345,
      true,
    );
  });

  it("does not expose status without the exact capability", () => {
    const plugin = createCoordinatedDeployHmrPlugin({
      pathname,
      worktreeRoot: "/workspace/live",
      channel: "dev-live-1234567890",
    });
    const handler = middlewareFor(plugin);
    const res = response();
    handler({ headers: { authorization: "Bearer wrong" } }, res);
    expect(res.statusCode).toBe(403);
  });

  it("resets its event observation for each exact deploy generation", () => {
    const plugin = createCoordinatedDeployHmrPlugin({
      pathname,
      worktreeRoot: "/workspace/live",
      channel: "dev-live-1234567890",
    });
    expect(hotUpdate(plugin)).toEqual([]);
    lease.release();
    lease = acquireDevDeployLock({
      pathname,
      worktreeRoot: "/workspace/live",
      channel: "dev-live-1234567890",
      suppressHmr: true,
    });

    const handler = middlewareFor(plugin);
    const res = response();
    handler(
      { headers: { authorization: `Bearer ${lease.record.token}` } },
      res,
    );
    expect(JSON.parse(res.body)).toMatchObject({
      generation: lease.record.generation,
      suppressedCount: 0,
      lastSuppressedAtUnixMs: null,
    });
  });

  it("returns to ordinary HMR as soon as the exact lease is released", () => {
    const plugin = createCoordinatedDeployHmrPlugin({
      pathname,
      worktreeRoot: "/workspace/live",
      channel: "dev-live-1234567890",
    });
    expect(hotUpdate(plugin)).toEqual([]);
    lease.release();
    expect(hotUpdate(plugin)).toBeUndefined();
  });
});
