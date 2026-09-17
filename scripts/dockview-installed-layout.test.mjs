// @vitest-environment jsdom

import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import "../src/test/setup";
import { assertHiddenBranchLayout } from "../src/qa/workspacePerformance/hiddenBranchLayout";
import { assertPaneContentReplacement } from "../src/qa/paneContentReplacement";
import { corepackExecutable } from "./lib/corepack-install.mjs";
import { scriptTestEnvironment } from "./lib/script-test-environment.mjs";
import { inspectNodeDependencyInstall, installNodeDependencies } from "./node-dependency-preflight.mjs";

const roots = [];
const patchPath = join(process.cwd(), "patches", "dockview-core@7.0.4.patch");
const { packageManager } = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "dure-dockview-install-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("preserves layout through updated and fresh frozen dependency installs", () => {
  const root = workspace();
  const store = workspace();
  const environment = scriptTestEnvironment();
  const manifest = {
    private: true,
    packageManager,
    dependencies: { "dockview-react": "7.0.4" },
  };
  const install = (cwd = root, flags = []) => execFileSync(corepackExecutable(environment), [
    "pnpm", "install", "--ignore-scripts", "--reporter", "append-only",
    "--store-dir", store,
    ...flags,
  ], { cwd, env: environment, encoding: "utf8", timeout: 60_000, shell: process.platform === "win32" });
  writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
  install();
  mkdirSync(join(root, "patches"));
  copyFileSync(patchPath, join(root, "patches", "dockview.patch"));
  manifest.pnpm = { patchedDependencies: { "dockview-core@7.0.4": "patches/dockview.patch" } };
  writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
  install();

  const updated = createRequire(join(root, "package.json"))("dockview-react");
  expect(() => assertHiddenBranchLayout(document, updated.createDockview)).not.toThrow();
  expect(() => assertPaneContentReplacement(document, updated.createDockview)).not.toThrow();

  const consumer = workspace();
  mkdirSync(join(consumer, "patches"));
  for (const file of ["package.json", "pnpm-lock.yaml", "patches/dockview.patch"]) {
    copyFileSync(join(root, file), join(consumer, file));
  }
  install(consumer, ["--frozen-lockfile"]);
  const frozen = createRequire(join(consumer, "package.json"))("dockview-react");
  expect(() => assertHiddenBranchLayout(document, frozen.createDockview)).not.toThrow();
  expect(() => assertPaneContentReplacement(document, frozen.createDockview)).not.toThrow();
}, 90_000);

it("replaces stale package contents and browser output even when the installed patch identity matches", async () => {
  const original = workspace();
  const consumer = workspace();
  const store = workspace();
  const environment = scriptTestEnvironment({ npm_config_store_dir: store });
  const manifest = {
    private: true,
    packageManager,
    dependencies: { "dockview-react": "7.0.4" },
  };
  const install = (cwd) => execFileSync(corepackExecutable(environment), [
    "pnpm", "install", "--ignore-scripts", "--reporter", "append-only",
  ], { cwd, env: environment, encoding: "utf8", timeout: 60_000, shell: process.platform === "win32" });
  const coreRoot = (cwd) => {
    let resolver = createRequire(join(cwd, "package.json"));
    let entry;
    for (const name of ["dockview-react", "dockview", "dockview-core"]) {
      entry = resolver.resolve(name);
      resolver = createRequire(entry);
    }
    return resolve(dirname(entry), "../..");
  };
  writeFileSync(join(original, "package.json"), JSON.stringify(manifest));
  install(original);
  mkdirSync(join(consumer, "patches"));
  copyFileSync(patchPath, join(consumer, "patches", "dockview.patch"));
  writeFileSync(join(consumer, "package.json"), JSON.stringify({
    ...manifest,
    pnpm: { patchedDependencies: { "dockview-core@7.0.4": "patches/dockview.patch" } },
  }));
  install(consumer);

  // Reproduce the observed Daily state: correct lock/hash, upstream payload.
  // Replace fixture files instead of writing through any store hardlinks.
  const installedCore = coreRoot(consumer);
  rmSync(installedCore, { recursive: true });
  cpSync(coreRoot(original), installedCore, { recursive: true });
  expect(inspectNodeDependencyInstall(consumer).ok).toBe(true);

  // Run Vite in Node, not jsdom's separate typed-array realm.
  const optimizeBrowser = () => {
    const vite = pathToFileURL(createRequire(import.meta.url).resolve("vite")).href;
    return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { optimizeDeps, resolveConfig } from ${JSON.stringify(vite)};
      const config = await resolveConfig({
        root: process.cwd(), configFile: false, logLevel: "silent",
        optimizeDeps: { include: ["dockview-react"] },
      }, "serve");
      const metadata = await optimizeDeps(config);
      process.stdout.write(JSON.stringify(metadata.optimized["dockview-react"].file));
    `], { cwd: consumer, env: environment, encoding: "utf8", timeout: 60_000 }));
  };
  const cached = optimizeBrowser();
  const staleBrowser = await import(pathToFileURL(cached).href);
  expect(() => assertHiddenBranchLayout(document, staleBrowser.createDockview)).toThrow(
    "hidden branch restore collapsed a visible row",
  );

  installNodeDependencies(consumer, environment);
  const installed = createRequire(join(consumer, "package.json"))("dockview-react");
  expect(() => assertHiddenBranchLayout(document, installed.createDockview)).not.toThrow();
  expect(() => assertPaneContentReplacement(document, installed.createDockview)).not.toThrow();

  const optimized = optimizeBrowser();
  const browser = await import(`${pathToFileURL(optimized).href}?reinstalled`);
  expect(() => assertHiddenBranchLayout(document, browser.createDockview)).not.toThrow();
  expect(() => assertPaneContentReplacement(document, browser.createDockview)).not.toThrow();
}, 90_000);
