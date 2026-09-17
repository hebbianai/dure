import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "vitest";

const source = name => readFileSync(new URL(`../crates/dure-app/control-plane/src/browser_engine/runtime/react/${name}.js`, import.meta.url), "utf8");

test.each(["tree", "suspense"])("%s restores the actual hook receiver after renderer failure", async name => {
  const emit = function () { assert.equal(this, hook); };
  const hook = { emit, rendererInterfaces: new Map([[1, { flushInitialOperations() { throw new Error("renderer failed"); } }]]) };
  const context = vm.createContext({ window: { __REACT_DEVTOOLS_GLOBAL_HOOK__: hook }, setTimeout });
  await assert.rejects(vm.runInContext(source(name), context), /renderer failed/);
  assert.equal(hook.emit, emit);
});

test("profiling stop handles long recordings and restores only its own commit callback", () => {
  const commit = function () { assert.equal(this, hook); };
  const hook = { onCommitFiberRoot: commit };
  const window = { __REACT_DEVTOOLS_GLOBAL_HOOK__: hook };
  window.top = window;
  const cancelled = [];
  const context = vm.createContext({ window, performance: { now: () => 100 }, requestAnimationFrame: () => 23, cancelAnimationFrame: id => cancelled.push(id) });
  vm.runInContext(source("renders-init"), context);
  window.__AB_RENDERS_FPS__.frames = Array(200_000).fill(20);
  const result = JSON.parse(vm.runInContext(source("renders-stop"), context));
  assert.deepEqual(result.fps, { avg: 50, min: 50, max: 50, drops: 0 });
  assert.equal(hook.onCommitFiberRoot, commit);
  assert.deepEqual(cancelled, [23]);
  assert.equal(window.__AB_RENDERS_ACTIVE__, undefined);
  assert.throws(() => vm.runInContext(source("renders-stop"), context), /not active/);
  assert.equal(hook.onCommitFiberRoot, commit);
  vm.runInContext(source("renders-init"), context);
  const subsequent = () => {};
  hook.onCommitFiberRoot = subsequent;
  vm.runInContext(source("renders-stop"), context);
  assert.equal(hook.onCommitFiberRoot, subsequent);
});

test("profile activation fails without a hook and leaves child frames untouched", () => {
  const window = {};
  window.top = window;
  assert.throws(() => vm.runInNewContext(source("renders-init"), { window }), /hook not installed/);
  assert.equal(window.__AB_RENDERS_ACTIVE__, undefined);
  window.top = {};
  vm.runInNewContext(source("renders-init"), { window });
  assert.equal(window.__AB_RENDERS_ACTIVE__, undefined);
});

test.each(["commit callback", "animation frame"])("failed profiler activation at %s rolls back its owned state", failure => {
  const original = () => {};
  const hook = { onCommitFiberRoot: original };
  if (failure === "commit callback") {
    Object.defineProperty(hook, "onCommitFiberRoot", {
      get: () => original,
      set() { throw new Error("fixture activation failure"); },
    });
  }
  const window = { __REACT_DEVTOOLS_GLOBAL_HOOK__: hook };
  window.top = window;
  const frames = new Set();
  const context = vm.createContext({
    window, performance: { now: () => 100 },
    requestAnimationFrame() {
      if (failure === "animation frame") throw new Error("fixture activation failure");
      frames.add(23); return 23;
    },
    cancelAnimationFrame: id => frames.delete(id),
  });
  assert.throws(() => vm.runInContext(source("renders-init"), context), /fixture activation failure/);
  assert.equal(window.__AB_RENDERS_ACTIVE__, undefined);
  assert.equal(window.__AB_RENDERS__, undefined);
  assert.equal(hook.onCommitFiberRoot, original);
  assert.equal(frames.size, 0);
});
