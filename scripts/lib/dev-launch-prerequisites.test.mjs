import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { devLaunchPrerequisites } from "./dev-launch-prerequisites.mjs";
import { writeFixtureTauriCli } from "./dev-launch-test-support.mjs";
import { scriptTestEnvironment } from "./script-test-environment.mjs";

const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function priorityRecorder(label) {
  return `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { getPriority } from "node:os";
appendFileSync(
  process.env.DURE_TEST_PRIORITY_EVENTS,
  JSON.stringify({
    label: ${JSON.stringify(label)},
    priority: getPriority(),
    parentPriority: getPriority(process.ppid),
  }) + "\\n",
);
`;
}

describe("dev launch prerequisites", () => {
  it.each([true, false])(
    "prepares installed native inputs before the frontend and app launcher (input present: %s)",
    (inputPresent) => {
      const root = mkdtempSync(join(tmpdir(), "dure-priority-"));
      const scripts = join(root, "scripts");
      const eventsPath = join(root, "events.jsonl");
      temporaryRoots.push(root);
      mkdirSync(scripts);

      writeFileSync(join(scripts, "guard-dev-channel.mjs"), priorityRecorder("guard"));
      const packageRoot = join(root, "node_modules", "serve-sim");
      const library = join(root, "src-tauri", "resources", "mobile-runtime", "serve-sim-native.dylib");
      const bytes = "fixture native library";
      copyFileSync(fileURLToPath(new URL("../stage-mobile-runtime.mjs", import.meta.url)), join(scripts, "stage-mobile-runtime.mjs"));
      writeFileSync(join(scripts, "node-dependency-preflight.mjs"), priorityRecorder("node-preflight") + `
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const packageRoot = ${JSON.stringify(packageRoot)};
mkdirSync(join(packageRoot, "dist", "native"), { recursive: true });
writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
  name: "serve-sim", type: "module", exports: { "./middleware": "./dist/middleware.mjs" },
}));
writeFileSync(join(packageRoot, "dist", "middleware.mjs"), "");
if (${inputPresent}) writeFileSync(join(packageRoot, "dist", "native", "serve-sim-native.node"), ${JSON.stringify(bytes)});
`);
      writeFileSync(join(scripts, "run-dev-frontend.mjs"), `import { readFileSync } from "node:fs";
if (process.platform === "darwin" && readFileSync(${JSON.stringify(library)}, "utf8") !== ${JSON.stringify(bytes)}) throw new Error("native library was not staged");
` + priorityRecorder("frontend-check").replace("#!/usr/bin/env node\n", ""));
      writeFileSync(join(scripts, "agent-tools-fixture.mjs"), priorityRecorder("agent-tools"));
      writeFileSync(join(scripts, "prepare-agent-tools.sh"),
        `#!/bin/sh\nexec "${process.execPath}" "${join(scripts, "agent-tools-fixture.mjs")}"\n`);
      writeFixtureTauriCli(
        root,
        `const { appendFileSync } = require("node:fs");
const { getPriority } = require("node:os");
if (process.argv.slice(2).join(" ") !== "--version") process.exit(64);
appendFileSync(
  process.env.DURE_TEST_PRIORITY_EVENTS,
  JSON.stringify({
    label: "tauri-check",
    priority: getPriority(),
    parentPriority: getPriority(process.ppid),
  }) + "\\n",
);
`,
      );

      const prerequisites = devLaunchPrerequisites({
        worktreeRoot: root,
        childEnvironment: scriptTestEnvironment({
          HOME: root,
          DURE_HOME: join(root, "state"),
          HMUX_DISCOVERY_ROOT: join(root, "discovery"),
          DURE_TEST_PRIORITY_EVENTS: eventsPath,
          PATH: root,
        }),
        devServer: { host: "127.0.0.1", port: 1420 },
      });
      let failure = null;
      for (const prerequisite of prerequisites) {
        const result = spawnSync(prerequisite.command, prerequisite.args, {
          ...prerequisite.spawnOptions,
          stdio: "pipe",
        });
        if (result.status !== 0) {
          failure = result;
          break;
        }
      }

      const events = readFileSync(eventsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      if (process.platform === "darwin" && !inputPresent) {
        expect(failure?.status).not.toBe(0);
        expect(failure?.stderr?.toString()).toContain("serve-sim-native.node");
        expect(existsSync(library)).toBe(false);
        expect(events.map(({ label }) => label)).toEqual(["guard", "node-preflight"]);
        return;
      }
      expect(failure, failure?.stderr?.toString()).toBe(null);
      if (process.platform === "darwin") expect(readFileSync(library, "utf8")).toBe(bytes);
      else expect(existsSync(library)).toBe(false);
      expect(events.map(({ label }) => label)).toEqual([
        "guard",
        "node-preflight",
        ...(process.platform === "win32" ? [] : ["agent-tools"]),
        "frontend-check",
        "tauri-check",
      ]);
      expect(
        events.every(({ priority, parentPriority }) => priority === parentPriority),
      ).toBe(true);
    },
  );
});
