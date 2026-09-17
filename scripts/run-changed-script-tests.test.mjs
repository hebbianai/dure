import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { scriptTestEnvironment } from "./lib/script-test-environment.mjs";
import {
  affectedScriptTests,
  runSelectedScriptTests,
  scriptModuleReferences,
  selectChangedScriptTests,
  vitestArguments,
  scriptTestInvocations,
} from "./run-changed-script-tests.mjs";
import {
  DEADLINE_SENSITIVE_PROCESS_TEST_PATHS,
  PROCESS_FIXTURE_TEST_PATHS,
  NODE_TEST_PATHS,
  scriptTestProjectForPath,
} from "./lib/script-test-projects.mjs";

function invocationArguments(selection) {
  return scriptTestInvocations(selection).map(({ args }) => args);
}

const base = "1".repeat(40);
const head = "2".repeat(40);

function gitFixture(diffOutput, { ancestor = true } = {}) {
  return vi.fn((args) => {
    if (args[0] === "rev-parse") {
      return { status: 0, stdout: Buffer.from(`${head}\n`) };
    }
    if (args[0] === "merge-base") {
      return { status: ancestor ? 0 : 1, stdout: Buffer.alloc(0) };
    }
    if (args[0] === "diff") {
      return { status: 0, stdout: Buffer.from(diffOutput) };
    }
    throw new Error(`unexpected git arguments: ${args.join(" ")}`);
  });
}

function opaqueResourceSelection({
  additionalSources = [],
  changedPaths,
  moduleSource,
  resources,
}) {
  const sources = new Map([
    [
      "scripts/feature.test.mjs",
      'import { feature } from "./lib/feature.mjs";\nvoid feature;\n',
    ],
    ["scripts/lib/feature.mjs", moduleSource],
    ["scripts/unrelated.test.mjs", "export const unrelated = true;\n"],
    ...additionalSources,
    ...resources.map((resourcePath) => [
      resourcePath,
      "opaque resource bytes\n",
    ]),
  ]);
  const readSource = vi.fn((sourcePath) => sources.get(sourcePath));
  const selection = selectChangedScriptTests({
    base,
    git: gitFixture(
      Buffer.from(changedPaths.map((sourcePath) => `${sourcePath}\0`).join("")),
    ),
    pathExists: (sourcePath) => sources.has(sourcePath),
    readSource,
    scriptPaths: [...sources.keys()].filter(
      (sourcePath) =>
        sourcePath.endsWith(".mjs") || sourcePath.endsWith(".js"),
    ),
  });
  return { readSource, selection };
}

function dynamicConsumerSources(moduleSource) {
  return [
    [
      "scripts/dynamic.test.mjs",
      'import { dynamic } from "./lib/dynamic.mjs";\nvoid dynamic;\n',
    ],
    ["scripts/lib/dynamic.mjs", moduleSource],
  ];
}

describe("changed script test selection", () => {
  test("selects internal workflow consumers through the existing script graph", () => {
    const sources = new Map([
      ["scripts/internal/workflow.test.mjs", 'import "../lib/shared.mjs";'],
      ["scripts/public.test.mjs", 'import "./lib/shared.mjs";'],
      ["scripts/lib/shared.mjs", "export const value = 1;"],
      ["scripts/unrelated.test.mjs", "export const unrelated = true;"],
    ]);
    const options = {
      base,
      pathExists: (name) => sources.has(name),
      readSource: (name) => sources.get(name),
      scriptPaths: [...sources.keys()],
    };
    const shared = selectChangedScriptTests({
      ...options,
      git: gitFixture(Buffer.from("scripts/lib/shared.mjs\0")),
    });
    expect(shared.mode).toBe("changed");
    expect(shared.paths).toEqual([
      "scripts/internal/workflow.test.mjs",
      "scripts/public.test.mjs",
    ]);
    const direct = selectChangedScriptTests({
      ...options,
      git: gitFixture(Buffer.from("scripts/internal/workflow.test.mjs\0")),
    });
    expect(direct.paths).toEqual(["scripts/internal/workflow.test.mjs"]);
    expect(invocationArguments(direct)).toHaveLength(1);
    expect(scriptTestProjectForPath(direct.paths[0])).toBe("scripts");
    sources.delete("scripts/internal/workflow.test.mjs");
    const publicOnly = selectChangedScriptTests({
      ...options,
      scriptPaths: [...sources.keys()],
      git: gitFixture(Buffer.from("scripts/lib/shared.mjs\0")),
    });
    expect(publicOnly.mode).toBe("changed");
    expect(publicOnly.paths).toEqual(["scripts/public.test.mjs"]);
  });

  test("fails closed to the full suite without an exact base", () => {
    expect(selectChangedScriptTests()).toEqual({
      mode: "all",
      paths: [],
      reason: "verification base is unavailable or invalid",
    });
  });

  test("fails closed when the supplied base is not an ancestor", () => {
    const selection = selectChangedScriptTests({
      base,
      git: gitFixture(Buffer.alloc(0), { ancestor: false }),
    });
    expect(selection.mode).toBe("all");
    expect(selection.reason).toContain("not an ancestor");
  });

  test("selects only current changed script tests in stable order", () => {
    const selection = selectChangedScriptTests({
      base,
      git: gitFixture(
        Buffer.from(
          "scripts/z.test.mjs\0scripts/a.test.mjs\0src/x.test.mjs\0",
        ),
      ),
      pathExists: (path) => path !== "scripts/z.test.mjs",
      scriptPaths: ["scripts/a.test.mjs"],
    });
    expect(selection).toEqual({
      mode: "changed",
      paths: ["scripts/a.test.mjs"],
      reason: null,
    });
  });

  test("selects tests that transitively consume changed script implementations", () => {
    const sources = new Map([
      [
        "scripts/feature.test.mjs",
        'import { feature } from "./lib/feature.mjs";\nvoid feature;\n',
      ],
      [
        "scripts/lib/feature.mjs",
        'export { shared } from "./shared.mjs";\n',
      ],
      ["scripts/lib/shared.mjs", "export const shared = true;\n"],
      ["scripts/unrelated.test.mjs", "export const unrelated = true;\n"],
    ]);
    const scriptPaths = [...sources.keys()];
    const readSource = (sourcePath) => sources.get(sourcePath);

    expect(
      affectedScriptTests({
        changedPaths: ["scripts/lib/shared.mjs"],
        readSource,
        scriptPaths,
      }),
    ).toEqual({ paths: ["scripts/feature.test.mjs"], unresolved: [] });
    expect(
      selectChangedScriptTests({
        base,
        git: gitFixture(Buffer.from("scripts/lib/shared.mjs\0")),
        pathExists: (sourcePath) => sources.has(sourcePath),
        readSource,
        scriptPaths,
      }),
    ).toEqual({
      mode: "changed",
      paths: ["scripts/feature.test.mjs"],
      reason: null,
    });
  });

  test("selects every transitive consumer through cyclic modules", () => {
    const resourcePath = "scripts/native/feature.c";
    const sources = new Map([
      ["scripts/a.test.mjs", 'import "./lib/a.mjs";\n'],
      ["scripts/b.test.mjs", 'import "./lib/b.mjs";\n'],
      [
        "scripts/lib/a.mjs",
        'import "./b.mjs";\nexport const resource = new URL("../native/feature.c", import.meta.url);\n',
      ],
      ["scripts/lib/b.mjs", 'import "./a.mjs";\n'],
      [resourcePath, "opaque resource bytes\n"],
    ]);

    expect(
      selectChangedScriptTests({
        base,
        git: gitFixture(Buffer.from(`${resourcePath}\0`)),
        pathExists: (sourcePath) => sources.has(sourcePath),
        readSource: (sourcePath) => sources.get(sourcePath),
        scriptPaths: [...sources.keys()].filter((sourcePath) =>
          sourcePath.endsWith(".mjs"),
        ),
      }),
    ).toEqual({
      mode: "changed",
      paths: ["scripts/a.test.mjs", "scripts/b.test.mjs"],
      reason: null,
    });
  });

  test.each(["py", "sh", "c"])(
    "selects tests for referenced opaque .%s resources without parsing them",
    (extension) => {
      const resourcePath = `scripts/native/feature.${extension}`;
      const { readSource, selection } = opaqueResourceSelection({
        changedPaths: [resourcePath],
        moduleSource: `export const feature = new URL("../native/feature.${extension}", import.meta.url);\n`,
        resources: [resourcePath],
      });

      expect(selection).toEqual({
        mode: "changed",
        paths: ["scripts/feature.test.mjs"],
        reason: null,
      });
      expect(readSource).not.toHaveBeenCalledWith(resourcePath);
    },
  );

  test.each(["py", "sh", "c"])(
    "falls back to all tests for an unreferenced opaque .%s resource",
    (extension) => {
      const resourcePath = `scripts/native/unreferenced.${extension}`;
      const { readSource, selection } = opaqueResourceSelection({
        changedPaths: [resourcePath],
        moduleSource: "export const feature = true;\n",
        resources: [resourcePath],
      });

      expect(selection.mode).toBe("all");
      expect(selection.reason).toContain("test consumer set is incomplete");
      expect(readSource).not.toHaveBeenCalledWith(resourcePath);
    },
  );

  test.each(["sh", "c"])(
    "falls back to all tests for a dynamically referenced opaque .%s resource",
    (extension) => {
      const resourcePath = `scripts/native/dynamic.${extension}`;
      const { selection } = opaqueResourceSelection({
        changedPaths: [resourcePath],
        moduleSource: `const name = "dynamic";\nexport const feature = new URL(\`../native/\${name}.${extension}\`, import.meta.url);\n`,
        resources: [resourcePath],
      });

      expect(selection.mode).toBe("all");
      expect(selection.reason).toContain("test consumer set is incomplete");
    },
  );

  test.each([
    'export const dynamic = path.join(directory, "feature.sh");\n',
    'const name = "feature";\nexport const dynamic = new URL(`../native/${name}.sh`, import.meta.url);\n',
    'const extension = "sh";\nexport const dynamic = new URL(`../native/feature.${extension}`, import.meta.url);\n',
    'const name = "feature";\nexport const dynamic = "../native/" + name + ".sh";\n',
    'const name = "feature";\nexport const dynamic = path.join(directory, `${name}.sh`);\n',
  ])(
    "does not let an exact edge mask a dynamic opaque resource consumer",
    (dynamicSource) => {
      const resourcePath = "scripts/native/feature.sh";
      const { selection } = opaqueResourceSelection({
        additionalSources: dynamicConsumerSources(dynamicSource),
        changedPaths: [resourcePath],
        moduleSource:
          'export const feature = new URL("../native/feature.sh", import.meta.url);\n',
        resources: [resourcePath],
      });

      expect(selection.mode).toBe("all");
      expect(selection.reason).toContain("test consumer set is incomplete");
    },
  );

  test("does not let a same-source exact edge mask an ambiguous reference", () => {
    const resourcePath = "scripts/native/feature.sh";
    const { selection } = opaqueResourceSelection({
      changedPaths: [resourcePath],
      moduleSource:
        'const description = "feature.sh";\nexport const feature = new URL("../native/feature.sh", import.meta.url);\n',
      resources: [resourcePath],
    });

    expect(selection.mode).toBe("all");
    expect(selection.reason).toContain("test consumer set is incomplete");
  });

  test("limits ambiguous hints to reachable resources with the same suffix", () => {
    const unreachablePath = "scripts/lib/unreachable.mjs";
    const unreachable = opaqueResourceSelection({
      additionalSources: [
        [
          unreachablePath,
          'export const dynamic = path.join(directory, "feature.sh");\n',
        ],
      ],
      changedPaths: ["scripts/native/feature.sh"],
      moduleSource:
        'export const feature = new URL("../native/feature.sh", import.meta.url);\n',
      resources: ["scripts/native/feature.sh"],
    });
    const otherSuffix = opaqueResourceSelection({
      additionalSources: dynamicConsumerSources(
        'export const dynamic = path.join(directory, "feature.sh");\n',
      ),
      changedPaths: ["scripts/native/feature.c"],
      moduleSource:
        'export const feature = new URL("../native/feature.c", import.meta.url);\n',
      resources: ["scripts/native/feature.c"],
    });
    const otherBasename = opaqueResourceSelection({
      additionalSources: dynamicConsumerSources(
        'export const dynamic = path.join(directory, "other.sh");\n',
      ),
      changedPaths: ["scripts/native/feature.sh"],
      moduleSource:
        'export const feature = new URL("../native/feature.sh", import.meta.url);\n',
      resources: ["scripts/native/feature.sh"],
    });
    const nonOpaqueTemplate = opaqueResourceSelection({
      additionalSources: dynamicConsumerSources(
        'const name = "feature";\nexport const dynamic = new URL(`../native/${name}.json`, import.meta.url);\n',
      ),
      changedPaths: ["scripts/native/feature.c"],
      moduleSource:
        'export const feature = new URL("../native/feature.c", import.meta.url);\n',
      resources: ["scripts/native/feature.c"],
    });

    for (const { selection } of [
      unreachable,
      otherSuffix,
      otherBasename,
      nonOpaqueTemplate,
    ]) {
      expect(selection).toEqual({
        mode: "changed",
        paths: ["scripts/feature.test.mjs"],
        reason: null,
      });
    }
    expect(unreachable.readSource).not.toHaveBeenCalledWith(unreachablePath);
  });

  test.each(["py", "sh", "c"])(
    "falls back to all tests when a referenced opaque .%s resource was removed",
    (extension) => {
      const resourcePath = `scripts/native/removed.${extension}`;
      const { selection } = opaqueResourceSelection({
        changedPaths: [resourcePath],
        moduleSource: `export const feature = new URL("../native/removed.${extension}", import.meta.url);\n`,
        resources: [],
      });

      expect(selection.mode).toBe("all");
      expect(selection.reason).toContain("opaque resource is absent");
    },
  );

  test.each(["sh", "c"])(
    "falls back to all tests when an opaque .%s resource was renamed",
    (extension) => {
      const oldPath = `scripts/native/old.${extension}`;
      const newPath = `scripts/native/new.${extension}`;
      const { selection } = opaqueResourceSelection({
        changedPaths: [oldPath, newPath],
        moduleSource: `export const feature = new URL("../native/new.${extension}", import.meta.url);\n`,
        resources: [newPath],
      });

      expect(selection.mode).toBe("all");
      expect(selection.reason).toContain("opaque resource is absent");
    },
  );

  test("selects script contracts that transitively consume changed CLI modules", () => {
    const sources = new Map([
      [
        "scripts/dure-cli.test.mjs",
        'const cli = new URL("../cli/dure.mjs", import.meta.url);\nvoid cli;\n',
      ],
      [
        "cli/dure.mjs",
        'import { send } from "./lib/message.mjs";\nvoid send;\n',
      ],
      ["cli/lib/message.mjs", "export const send = true;\n"],
      ["scripts/unrelated.test.mjs", "export const unrelated = true;\n"],
    ]);
    const scriptPaths = [...sources.keys()];
    const readSource = (sourcePath) => sources.get(sourcePath);

    expect(
      selectChangedScriptTests({
        base,
        git: gitFixture(Buffer.from("cli/lib/message.mjs\0")),
        pathExists: (sourcePath) => sources.has(sourcePath),
        readSource,
        scriptPaths,
      }),
    ).toEqual({
      mode: "changed",
      paths: ["scripts/dure-cli.test.mjs"],
      reason: null,
    });
    expect(
      selectChangedScriptTests({
        base,
        git: gitFixture(Buffer.from("cli/lib/message.mjs\0")),
        pathExists: (sourcePath) =>
          sourcePath !== "cli/lib/message.mjs" && sources.has(sourcePath),
        readSource,
        scriptPaths,
      }),
    ).toEqual({
      mode: "changed",
      paths: ["scripts/dure-cli.test.mjs"],
      reason: null,
    });
  });

  test("recognizes executable modules referenced through import-meta URLs", () => {
    expect(
      scriptModuleReferences(
        "scripts/runner.test.mjs",
        'const runner = new URL("./runner.mjs", import.meta.url);\nvoid runner;\n',
      ),
    ).toContain("scripts/runner.mjs");
    expect(
      scriptModuleReferences(
        "scripts/dure-cli.test.mjs",
        'const cli = new URL("../cli/dure.mjs", import.meta.url);\nvoid cli;\n',
      ),
    ).toContain("cli/dure.mjs");
  });

  test("falls back to every script test when an implementation has no consumer", () => {
    const selection = selectChangedScriptTests({
      base,
      git: gitFixture(Buffer.from("scripts/lib/orphan.mjs\0")),
      pathExists: () => true,
      readSource: () => "export const orphan = true;\n",
      scriptPaths: ["scripts/lib/orphan.mjs", "scripts/a.test.mjs"],
    });
    expect(selection.mode).toBe("all");
    expect(selection.reason).toContain("test consumer set is incomplete");
  });

  test("malformed Git output falls back to every script test", () => {
    const selection = selectChangedScriptTests({
      base,
      git: gitFixture(Buffer.from("scripts/a.test.mjs")),
    });
    expect(selection.mode).toBe("all");
    expect(selection.reason).toContain("malformed");
  });

  test("rejects syntax errors in changed implementations before running tests", () => {
    expect(() =>
      selectChangedScriptTests({
        base,
        git: gitFixture(Buffer.from("scripts/lib/broken.mjs\0")),
        pathExists: () => true,
        readSource: () => "export const = ;\n",
        scriptPaths: ["scripts/lib/broken.mjs"],
      }),
    ).toThrow("script syntax invalid");
  });

  test("passes selected paths as arguments without a shell", () => {
    expect(
      vitestArguments("scripts", [
        "scripts/a.test.mjs",
        "scripts/b.test.mjs",
      ]),
    ).toEqual([
      "pnpm",
      "exec",
      "vitest",
      "run",
      "--project",
      "scripts",
      "scripts/a.test.mjs",
      "scripts/b.test.mjs",
    ]);
  });

  test.each(
    [NODE_TEST_PATHS[0], "scripts/qa/managed-qwen-hooks.test.mjs"].flatMap(
      (selectedPath) => [false, true].map((fails) => ({ selectedPath, fails })),
    ),
  )("executes $selectedPath and preserves failure=$fails", ({ selectedPath, fails }) => {
    const root = mkdtempSync(join(tmpdir(), "dure-script-node-runner-"));
    const source = `import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("runner fixture", () => assert.equal(${fails}, false));\n`;
    const observations = [];
    try {
      mkdirSync(dirname(join(root, selectedPath)), { recursive: true });
      writeFileSync(join(root, selectedPath), source);
      const status = runSelectedScriptTests({
        base,
        selectionOptions: {
          git: gitFixture(Buffer.from(`${selectedPath}\0`)),
          pathExists: () => true,
          readSource: () => source,
          scriptPaths: [selectedPath],
        },
        run: (command, args) => {
          const result = spawnSync(command, args, {
            cwd: root,
            env: scriptTestEnvironment({ HOME: root, HMUX_DISCOVERY_ROOT: join(root, "discovery") }),
            encoding: "utf8",
          });
          observations.push({ command, args, result });
          return result;
        },
      });
      expect(observations).toHaveLength(1);
      expect(observations[0].command).toBe(process.execPath);
      expect(observations[0].args).toEqual(["--test", selectedPath]);
      expect(observations[0].result.stdout).toContain("runner fixture");
      expect(status).toBe(fails ? 1 : 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("runs Node, fast and process fixture projects sequentially without range evidence", () => {
    const run = vi.fn(() => ({ status: 0 }));
    const isolatedInvocations = (project, paths) =>
      paths.map((path) => [
        "pnpm",
        "exec",
        "vitest",
        "run",
        "--project",
        project,
        path,
      ]);
    expect(
      runSelectedScriptTests({
        base: "invalid",
        run,
        selectionOptions: { scriptPaths: [] },
      }),
    ).toBe(0);
    expect(run.mock.calls.map(([, arguments_]) => arguments_)).toEqual([
      ...NODE_TEST_PATHS.map((path) => ["--test", path]),
      ["pnpm", "exec", "vitest", "run", "--project", "scripts"],
      ...isolatedInvocations(
        "scripts-deadline",
        DEADLINE_SENSITIVE_PROCESS_TEST_PATHS,
      ),
      ...isolatedInvocations("scripts-process", PROCESS_FIXTURE_TEST_PATHS),
    ]);
  });

  test("routes changed process fixtures to the isolated project", () => {
    expect(
      invocationArguments({
        mode: "changed",
        paths: [
          "scripts/a.test.mjs",
          "scripts/dure-cli-hmux.test.mjs",
          "scripts/provision-hmux-remote.test.mjs",
          "scripts/qa/lib/tauri-app-runner.test.mjs",
        ],
      }),
    ).toEqual([
      [
        "pnpm",
        "exec",
        "vitest",
        "run",
        "--project",
        "scripts",
        "scripts/a.test.mjs",
      ],
      [
        "pnpm",
        "exec",
        "vitest",
        "run",
        "--project",
        "scripts-deadline",
        "scripts/dure-cli-hmux.test.mjs",
      ],
      [
        "pnpm",
        "exec",
        "vitest",
        "run",
        "--project",
        "scripts-process",
        "scripts/provision-hmux-remote.test.mjs",
      ],
      [
        "pnpm",
        "exec",
        "vitest",
        "run",
        "--project",
        "scripts-process",
        "scripts/qa/lib/tauri-app-runner.test.mjs",
      ],
    ]);
  });

  test("isolates dev launch lifecycle fixtures as separate process invocations", () => {
    const lifecycleFixtures = [
      "scripts/queue-dev-app-deploy.test.mjs",
      "scripts/lib/dev-launch-supervisor.test.mjs",
      "scripts/lib/dev-launch-supervisor.retirement-failure.test.mjs",
      "scripts/lib/process-group-witness.test.mjs",
      "scripts/qa/lib/tauri-app-launch.test.mjs",
      "scripts/qa/pane-app-restart-app.test.mjs",
      "scripts/run-dev-app.frontend-authority.test.mjs",
      "scripts/run-dev-app.test.mjs",
      "scripts/run-dev-frontend.test.mjs",
      "scripts/run-dev-launch-child.test.mjs",
    ];

    expect(lifecycleFixtures.map(scriptTestProjectForPath)).toEqual(
      lifecycleFixtures.map(() => "scripts-process"),
    );
    expect(
      invocationArguments({ mode: "changed", paths: lifecycleFixtures }),
    ).toEqual(
      lifecycleFixtures.map((path) => [
        "pnpm",
        "exec",
        "vitest",
        "run",
        "--project",
        "scripts-process",
        path,
      ]),
    );
  });

  test("isolates immutable CLI bundle fixtures as separate process invocations", () => {
    const bundleFixtures = [
      "scripts/dure-cli-diagnostics.test.mjs",
      "scripts/dure-cli-install.test.mjs",
    ];

    expect(bundleFixtures.map(scriptTestProjectForPath)).toEqual(
      bundleFixtures.map(() => "scripts-process"),
    );
    expect(invocationArguments({ mode: "changed", paths: bundleFixtures })).toEqual(
      bundleFixtures.map((path) => [
        "pnpm",
        "exec",
        "vitest",
        "run",
        "--project",
        "scripts-process",
        path,
      ]),
    );
  });

  test("isolates CLI and soak fixtures that own child-process deadlines", () => {
    const deadlineSensitiveFixtures = [
      "scripts/dure-cli-hmux.test.mjs",
      "scripts/dure-cli-ls.test.mjs",
      "scripts/dure-cli-orchestration-status.test.mjs",
      "scripts/dure-cli-read-latency.test.mjs",
      "scripts/dure-cli-wait.test.mjs",
      "scripts/lib/dev-hmux-tool.test.mjs",
      "scripts/lib/process-identity-relations.test.mjs",
      "scripts/qa/hmux-remote-soak.test.mjs",
      "scripts/qa/lib/bounded-owned-process-group.test.mjs",
      "scripts/qa/lib/owned-process-group.test.mjs",
      "scripts/qa/spawn-prompt-ssh-receipt-loss-smoke.test.mjs",
      "scripts/run-hmux-tests.test.mjs",
    ];

    expect(DEADLINE_SENSITIVE_PROCESS_TEST_PATHS).toEqual(
      expect.arrayContaining(deadlineSensitiveFixtures),
    );
    expect(deadlineSensitiveFixtures.map(scriptTestProjectForPath)).toEqual(
      deadlineSensitiveFixtures.map(() => "scripts-deadline"),
    );
  });

  test("skips execution when the exact diff only deleted tests", () => {
    const run = vi.fn();
    expect(
      runSelectedScriptTests({
        base,
        run,
        selectionOptions: {
          git: gitFixture(Buffer.from("scripts/deleted.test.mjs\0")),
          pathExists: () => false,
        },
      }),
    ).toBe(0);
    expect(run).not.toHaveBeenCalled();
  });
});
