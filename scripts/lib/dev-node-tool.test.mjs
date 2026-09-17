import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readPinnedDevNodeRuntime,
  resolvePinnedDevNodeTool,
} from "./dev-node-tool.mjs";

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function pinnedRoot(version) {
  const root = mkdtempSync(join(tmpdir(), "dure-node-tool-"));
  roots.push(root);
  writeFileSync(join(root, ".node-version"), `${version}\n`);
  writeFileSync(join(root, ".nvmrc"), `v${version}\n`);
  return root;
}

describe("dev Node tool", () => {
  it("selects one exact Node without requiring an adjacent Corepack", () => {
    const root = pinnedRoot("24.15.0");
    const inspectedPaths = [];
    const tool = resolvePinnedDevNodeTool({
      root,
      home: "/fixture/home",
      currentExecutable: "/managed/node-v24/bin/node",
      pathExists: (pathname) => {
        inspectedPaths.push(pathname);
        return pathname === "/managed/node-v24/bin/node";
      },
      run: () => "v24.15.0\n",
    });

    expect(tool).toEqual({
      version: "24.15.0",
      binDirectory: "/managed/node-v24/bin",
      nodeExecutable: "/managed/node-v24/bin/node",
    });
    expect(inspectedPaths).toEqual(["/managed/node-v24/bin/node"]);
  });

  it("rejects disagreeing pins and a missing exact runtime", () => {
    const root = pinnedRoot("24.15.0");
    writeFileSync(join(root, ".nvmrc"), "25.0.0\n");
    expect(() => readPinnedDevNodeRuntime(root)).toThrow(/pins disagree/);
    writeFileSync(join(root, ".nvmrc"), "24.15.0\n");
    expect(() =>
      resolvePinnedDevNodeTool({
        root,
        home: "/fixture/home",
        currentExecutable: "/missing/node",
        pathExists: () => false,
      }),
    ).toThrow(/dev_node_runtime_unavailable.*24\.15\.0/);
  });
});
