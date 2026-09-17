import fs from "node:fs";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createServer } from "vite";
import viteConfig from "../vite.config.ts";
import { waitForQaLogReceipt } from "./qa/lib/qa-log-receipt.mjs";

async function waitFor(predicate, description, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function watchedFile(server, pathname) {
  const directory = path.dirname(pathname);
  const basename = path.basename(pathname);
  return (server.watcher.getWatched()[directory] ?? []).includes(basename);
}

describe("Vite development config", () => {
  it("delivers an HTTP QA report to the isolated receipt reader without a checkout log", async () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dure-vite-qa-http-"));
    const previousStateRoot = process.env.DURE_QA_STATE_ROOT;
    process.env.DURE_QA_STATE_ROOT = stateRoot;
    let server;
    try {
      const config = await viteConfig({ command: "serve", mode: "development" });
      const plugin = config.plugins.flat(Infinity).find((candidate) => candidate?.name === "qa-log");
      server = await createServer({ configFile: false, root: stateRoot, appType: "custom", logLevel: "silent",
        plugins: [plugin], server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } });
      await server.listen();
      const response = await fetch(`http://127.0.0.1:${server.httpServer.address().port}/__qa_log`, {
        method: "POST", body: JSON.stringify(["pane-conversion", { proof: "http-owned", result: "passed" }]),
      });
      expect(await response.text()).toBe("ok");
      expect(await waitForQaLogReceipt("pane-conversion", "http-owned", { timeoutMs: 100 }))
        .toEqual({ proof: "http-owned", result: "passed" });
      expect(fs.readFileSync(path.join(stateRoot, "qa.log"), "utf8").split("\n").filter(Boolean)).toHaveLength(1);
    } finally {
      await server?.close();
      if (previousStateRoot === undefined) delete process.env.DURE_QA_STATE_ROOT;
      else process.env.DURE_QA_STATE_ROOT = previousStateRoot;
      fs.rmSync(stateRoot, { force: true, recursive: true });
    }
  });

  it("writes isolated QA reports only to their runner-owned log", async () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dure-vite-qa-log-"));
    const previousStateRoot = process.env.DURE_QA_STATE_ROOT;
    process.env.DURE_QA_STATE_ROOT = stateRoot;
    const append = vi.spyOn(fs, "appendFileSync").mockImplementation(() => {});
    try {
      const config = await viteConfig({ command: "serve", mode: "development" });
      const plugin = config.plugins.flat(Infinity).find((candidate) => candidate?.name === "qa-log");
      const routes = new Map();
      plugin.configureServer({ middlewares: { use: (route, handler) => routes.set(route, handler) } });
      const request = new EventEmitter();
      const end = vi.fn();
      routes.get("/__qa_log")(request, { end });
      request.emit("data", '["pane-conversion",');
      request.emit("data", '{"proof":"owned","result":"passed"}]');
      request.emit("end");
      expect(append).toHaveBeenCalledTimes(1);
      expect(append.mock.calls[0][0]).toBe(path.join(stateRoot, "qa.log"));
      expect(append.mock.calls[0][1]).toMatch(/\] \["pane-conversion",\{"proof":"owned","result":"passed"\}\]\n$/);
      expect(end).toHaveBeenCalledWith("ok");
    } finally {
      append.mockRestore();
      if (previousStateRoot === undefined) delete process.env.DURE_QA_STATE_ROOT;
      else process.env.DURE_QA_STATE_ROOT = previousStateRoot;
      fs.rmSync(stateRoot, { force: true, recursive: true });
    }
  });

  it("serves the runner-owned QA flag before the worktree fallback", async () => {
    expect(viteConfig).toBeTypeOf("function");
    if (typeof viteConfig !== "function") return;

    const stateRoot = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "dure-vite-qa-flag-"),
    );
    fs.writeFileSync(path.join(stateRoot, "qa.autorun"), "sshproject=owned\n");
    const previousStateRoot = process.env.DURE_QA_STATE_ROOT;
    process.env.DURE_QA_STATE_ROOT = stateRoot;
    try {
      const config = await viteConfig({
        command: "serve",
        mode: "development",
        isSsrBuild: false,
        isPreview: false,
      });
      const plugin = config.plugins
        ?.flat(Number.POSITIVE_INFINITY)
        .find((candidate) => candidate?.name === "qa-log");
      const routes = new Map();
      plugin?.configureServer?.({
        middlewares: {
          use(route, handler) {
            routes.set(route, handler);
          },
        },
      });
      const end = vi.fn();
      routes.get("/__qa_flag")?.({}, { end });

      expect(end).toHaveBeenCalledWith("sshproject=owned\n");
    } finally {
      if (previousStateRoot === undefined) {
        delete process.env.DURE_QA_STATE_ROOT;
      } else {
        process.env.DURE_QA_STATE_ROOT = previousStateRoot;
      }
      fs.rmSync(stateRoot, { force: true, recursive: true });
    }
  });

  it("ignores disk-GC reclaim transactions without ignoring live source", async () => {
    expect(viteConfig).toBeTypeOf("function");
    if (typeof viteConfig !== "function") return;

    const config = await viteConfig({
      command: "serve",
      mode: "development",
      isSsrBuild: false,
      isPreview: false,
    });
    const ignored = config.server?.watch?.ignored ?? [];

    expect(ignored).toContain(
      `${path.resolve(process.cwd(), ".dure-reclaim")}/**`,
    );
    expect(ignored).not.toContain(`${path.resolve(process.cwd(), "src")}/**`);
  });

  it("ignores Claude worktrees nested under the repository", async () => {
    expect(viteConfig).toBeTypeOf("function");
    if (typeof viteConfig !== "function") return;

    const config = await viteConfig({
      command: "serve",
      mode: "development",
      isSsrBuild: false,
      isPreview: false,
    });

    expect(config.server?.watch?.ignored).toContain(
      `${path.resolve(process.cwd(), ".claude/worktrees")}/**`,
    );
  });

  it("ignores Hmux build artifacts without ignoring Hmux source", async () => {
    expect(viteConfig).toBeTypeOf("function");
    if (typeof viteConfig !== "function") return;

    const config = await viteConfig({
      command: "serve",
      mode: "development",
      isSsrBuild: false,
      isPreview: false,
    });
    const ignored = config.server?.watch?.ignored ?? [];

    expect(ignored).toContain(`${path.resolve(process.cwd(), "hmux/target")}/**`);
    expect(ignored).not.toContain(`${path.resolve(process.cwd(), "hmux")}/**`);
  });

  it("keeps reclaim churn out of HMR while source edits remain observable", async () => {
    expect(viteConfig).toBeTypeOf("function");
    if (typeof viteConfig !== "function") return;

    const repositoryRoot = fs.realpathSync(process.cwd());
    const fixtureRoot = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "dure-vite-reclaim-watch-"),
    );
    const sourcePath = path.join(fixtureRoot, "src", "probe.ts");
    const reclaimRoot = path.join(fixtureRoot, ".dure-reclaim");
    const reclaimPath = path.join(
      reclaimRoot,
      "transaction",
      "target",
      "index.html",
    );
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(
      path.join(fixtureRoot, "index.html"),
      '<script type="module" src="/src/probe.ts"></script>\n',
    );
    fs.writeFileSync(
      sourcePath,
      "export const probe = 1;\nif (import.meta.hot) import.meta.hot.accept();\n",
    );
    fs.mkdirSync(path.dirname(reclaimPath), { recursive: true });
    fs.writeFileSync(reclaimPath, "reclaimed build output 1\n");

    let server;
    try {
      const config = await viteConfig({
        command: "serve",
        mode: "development",
        isSsrBuild: false,
        isPreview: false,
      });
      const configuredIgnored = config.server?.watch?.ignored ?? [];
      const reclaimPattern = `${path.join(repositoryRoot, ".dure-reclaim")}/**`;
      const ignored = configuredIgnored.map((pattern) =>
        path.join(fixtureRoot, path.relative(repositoryRoot, pattern)),
      );
      server = await createServer({
        appType: "spa",
        configFile: false,
        logLevel: "silent",
        root: fixtureRoot,
        server: { middlewareMode: true, watch: { ignored }, ws: false },
      });

      const watcherEvents = [];
      const hotPayloads = [];
      server.watcher.on("all", (event, pathname) => {
        watcherEvents.push({ event, pathname });
      });
      server.ws.send = (payload) => {
        hotPayloads.push(payload);
      };

      await waitFor(
        () =>
          watchedFile(server, sourcePath) &&
          (configuredIgnored.includes(reclaimPattern) ||
            watchedFile(server, reclaimPath)),
        "Vite to prepare the fixture watch graph",
      );
      await server.transformRequest("/src/probe.ts");
      watcherEvents.length = 0;
      hotPayloads.length = 0;

      fs.writeFileSync(reclaimPath, "reclaimed build output 2\n");
      fs.writeFileSync(
        sourcePath,
        "export const probe = 2;\nif (import.meta.hot) import.meta.hot.accept();\n",
      );

      await waitFor(
        () =>
          watcherEvents.some(
            ({ event, pathname }) =>
              event === "change" && pathname === sourcePath,
          ) &&
          hotPayloads.some(
            (payload) =>
              payload.type === "update" &&
              payload.updates.some(
                (update) =>
                  update.type === "js-update" &&
                  update.path === "/src/probe.ts",
              ),
        ),
        "the ordinary source HMR update",
      );
      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(
        hotPayloads.filter((payload) => payload.type === "full-reload"),
      ).toEqual([]);
      expect(
        watcherEvents.filter(
          ({ pathname }) =>
            pathname === reclaimRoot ||
            pathname.startsWith(`${reclaimRoot}${path.sep}`),
        ),
      ).toEqual([]);
      expect(configuredIgnored).toContain(reclaimPattern);
      expect(configuredIgnored).not.toContain(
        `${path.join(repositoryRoot, ".dure")}/**`,
      );
      expect(configuredIgnored).not.toContain("**/.dure-reclaim/**");
    } finally {
      try {
        await server?.close();
      } finally {
        fs.rmSync(fixtureRoot, { force: true, recursive: true });
      }
    }
  });
});
