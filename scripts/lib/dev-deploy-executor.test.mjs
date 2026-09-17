import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEV_DEPLOY_EXECUTOR_FILES,
  devDeployQueueEntrypoint,
  stageDevDeployExecutor,
} from "./dev-deploy-executor.mjs";

const FILES = DEV_DEPLOY_EXECUTOR_FILES;

let root;
let sourceRoot;
let queueDirectory;

function writeSources(suffix = "one") {
  for (const relativePath of FILES) {
    const pathname = join(sourceRoot, relativePath);
    mkdirSync(dirname(pathname), { recursive: true });
    writeFileSync(
      pathname,
      relativePath === "scripts/dev-deploy-executor-files.json"
        ? `${JSON.stringify(FILES, null, 2)}\n`
        : `// ${relativePath} ${suffix}\n`,
    );
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "deploy-executor-"));
  sourceRoot = join(root, "source");
  queueDirectory = join(root, "queue");
  mkdirSync(queueDirectory, { recursive: true, mode: 0o700 });
  writeSources();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("stageDevDeployExecutor", () => {
  it("stages an immutable content-addressed executor", () => {
    const first = stageDevDeployExecutor({ queueDirectory, sourceRoot });
    const second = stageDevDeployExecutor({ queueDirectory, sourceRoot });
    expect(second).toEqual(first);
    expect(first.generation).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(first.entrypoint, "utf8")).toContain(
      "deploy-dev-app.mjs one",
    );
    expect(readFileSync(devDeployQueueEntrypoint(first), "utf8")).toContain(
      "queue-dev-app-deploy.mjs one",
    );
    expect(() =>
      devDeployQueueEntrypoint({
        ...first,
        generation: "0".repeat(64),
      }),
    ).toThrow(/executor identity is invalid/);
  });

  it("creates a new snapshot when executor code changes", () => {
    const first = stageDevDeployExecutor({ queueDirectory, sourceRoot });
    writeSources("two");
    const second = stageDevDeployExecutor({ queueDirectory, sourceRoot });
    expect(second.generation).not.toBe(first.generation);
    expect(readFileSync(first.entrypoint, "utf8")).toContain("one");
    expect(readFileSync(second.entrypoint, "utf8")).toContain("two");
  });

  it("includes the target-owned manifest bytes in the content address", () => {
    const first = stageDevDeployExecutor({ queueDirectory, sourceRoot });
    writeFileSync(
      join(sourceRoot, "scripts/dev-deploy-executor-files.json"),
      JSON.stringify(FILES),
    );

    const second = stageDevDeployExecutor({ queueDirectory, sourceRoot });

    expect(second.generation).not.toBe(first.generation);
  });

  it("rejects a manifest without the detached queue entrypoint", () => {
    writeFileSync(
      join(sourceRoot, "scripts/dev-deploy-executor-files.json"),
      `${JSON.stringify(
        FILES.filter(
          (relativePath) =>
            relativePath !== "scripts/queue-dev-app-deploy.mjs",
        ),
      )}\n`,
    );

    expect(() =>
      stageDevDeployExecutor({ queueDirectory, sourceRoot }),
    ).toThrow(/manifest is invalid/);
  });

  it.each(["..\\outside.mjs", "C:/outside.mjs"])(
    "rejects non-canonical manifest path %s on every platform",
    (unsafePath) => {
      writeFileSync(
        join(sourceRoot, "scripts/dev-deploy-executor-files.json"),
        `${JSON.stringify([...FILES, unsafePath])}\n`,
      );

      expect(() =>
        stageDevDeployExecutor({ queueDirectory, sourceRoot }),
      ).toThrow(/manifest is invalid/);
    },
  );

  it("rejects a source file reached through an escaping parent symlink", () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "helper.mjs"), "export const escaped = true;\n");
    symlinkSync(
      outside,
      join(sourceRoot, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    writeFileSync(
      join(sourceRoot, "scripts/dev-deploy-executor-files.json"),
      `${JSON.stringify([...FILES, "linked/helper.mjs"])}\n`,
    );

    expect(() =>
      stageDevDeployExecutor({ queueDirectory, sourceRoot }),
    ).toThrow(/source is unsafe/);
  });

  it("uses the target commit's executor manifest", () => {
    execFileSync("git", ["init", "--quiet"], { cwd: sourceRoot });
    execFileSync("git", ["add", "."], { cwd: sourceRoot });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "-m",
        "base executor",
      ],
      { cwd: sourceRoot },
    );
    const futureHelper = "scripts/lib/future-deploy-helper.mjs";
    writeFileSync(join(sourceRoot, futureHelper), "export const future = true;\n");
    writeFileSync(
      join(sourceRoot, "scripts/dev-deploy-executor-files.json"),
      `${JSON.stringify([...FILES, futureHelper], null, 2)}\n`,
    );
    execFileSync("git", ["add", "."], { cwd: sourceRoot });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "-m",
        "target executor",
      ],
      { cwd: sourceRoot },
    );
    const sourceHead = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: sourceRoot,
      encoding: "utf8",
    }).trim();

    const staged = stageDevDeployExecutor({
      queueDirectory,
      sourceRoot,
      sourceHead,
    });
    expect(
      readFileSync(
        join(dirname(dirname(staged.entrypoint)), futureHelper),
        "utf8",
      ),
    ).toContain("future = true");
  });

  it("stages the executable helper import closure", async () => {
    const executor = stageDevDeployExecutor({ queueDirectory });
    const { entrypoint } = executor;
    const snapshotRoot = dirname(dirname(entrypoint));

    await expect(
      import(`${pathToFileURL(entrypoint).href}?snapshot=${Date.now()}`),
    ).resolves.toBeDefined();
    const linkedEntrypoint = join(root, "staged-deploy-alias.mjs");
    symlinkSync(entrypoint, linkedEntrypoint);
    const directRun = spawnSync(
      process.execPath,
      [linkedEntrypoint, "--help"],
      { encoding: "utf8" },
    );
    expect(directRun.status).toBe(1);
    expect(directRun.stderr).toContain("unknown argument: --help");
    await expect(
      import(
        `${pathToFileURL(
          join(snapshotRoot, "scripts/lib/dev-launch-supervisor.mjs"),
        ).href}?snapshot=${Date.now()}`
      ),
    ).resolves.toMatchObject({ superviseDevLaunch: expect.any(Function) });
    await expect(
      import(
        `${pathToFileURL(
          join(snapshotRoot, "scripts/lib/dev-server-profile.mjs"),
        ).href}?snapshot=${Date.now()}`
      ),
    ).resolves.toMatchObject({ persistDevServerProfile: expect.any(Function) });
    const queueEntrypoint = devDeployQueueEntrypoint(executor);
    const queueHelp = spawnSync(
      process.execPath,
      [queueEntrypoint, "--help"],
      {
        encoding: "utf8",
        env: { ...process.env, HOME: join(root, "queue-home") },
      },
    );
    expect(queueHelp.status).toBe(0);
    expect(queueHelp.stdout).toContain("Usage:");
  });

  it("rejects a queue directory that is not owner-only", () => {
    chmodSync(queueDirectory, 0o755);
    expect(() =>
      stageDevDeployExecutor({ queueDirectory, sourceRoot }),
    ).toThrow(/unsafe/);
  });
});
