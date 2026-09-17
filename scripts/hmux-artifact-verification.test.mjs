import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const repositoryRoot = path.resolve(".");
const installScript = path.join(repositoryRoot, "scripts/install-hmux.sh");
const temporaryDirectories = [];

// Packaging, installation, and digest verification each cross process
// boundaries. The self-hosted runner executes the suite at background
// priority, where the complete round trip can exceed Vitest's 5s unit budget.
const ARTIFACT_FIXTURE_TIMEOUT_MS = 20_000;
const ARTIFACT_SUBPROCESS_TIMEOUT_MS = 10_000;
const ARTIFACT_SUBPROCESS_OUTPUT_LIMIT_BYTES = 1024 * 1024;

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hmux-verify-"));
  temporaryDirectories.push(directory);
  return directory;
}

function executable(pathname, contents) {
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  fs.writeFileSync(pathname, contents, { mode: 0o755 });
}

function structuredRuntimeFixture(contents) {
  const quoted = `'${contents.replaceAll("'", `'"'"'`)}'`;
  return `#!/bin/sh
# hmux-product-profile=structured-terminal-v1
if [ "\${1:-}" = "--no-autostart" ] &&
  [ "\${2:-}" = "hmux-build-info" ]; then
  printf '%s\\n' '{"productProfile":"structured-terminal-v1"}'
  exit 0
fi
printf '%s' ${quoted}
`;
}

// A tree in the shape the installer consumes, produced by the packaging script
// rather than hand-written, so a change to the manifest layout cannot make
// these tests pass against a format the installer no longer reads.
function signalOwnedProcessGroup(child, signal) {
  if (
    !Number.isSafeInteger(child.pid) ||
    child.pid <= 1 ||
    child.exitCode !== null ||
    child.signalCode !== null
  ) {
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") {
      throw error;
    }
  }
}

function runArtifactSubprocess(command, args, { cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      detached: true,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let outputLimitExceeded = false;
    let spawnError;
    let timedOut = false;

    const stopForLimit = (chunk, destination) => {
      outputBytes += chunk.length;
      if (outputBytes <= ARTIFACT_SUBPROCESS_OUTPUT_LIMIT_BYTES) {
        destination.push(chunk);
        return;
      }
      outputLimitExceeded = true;
      signalOwnedProcessGroup(child, "SIGKILL");
    };
    child.stdout.on("data", (chunk) => stopForLimit(chunk, stdout));
    child.stderr.on("data", (chunk) => stopForLimit(chunk, stderr));
    child.once("error", (error) => {
      spawnError = error;
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      signalOwnedProcessGroup(child, "SIGKILL");
    }, ARTIFACT_SUBPROCESS_TIMEOUT_MS);
    child.once("close", (status, signal) => {
      clearTimeout(timeout);
      const result = {
        signal,
        status,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      };
      if (spawnError) {
        reject(spawnError);
      } else if (timedOut) {
        reject(
          new Error(
            `artifact fixture subprocess timed out after ${ARTIFACT_SUBPROCESS_TIMEOUT_MS}ms: ${command}`,
          ),
        );
      } else if (outputLimitExceeded) {
        reject(
          new Error(
            `artifact fixture subprocess exceeded ${ARTIFACT_SUBPROCESS_OUTPUT_LIMIT_BYTES} bytes: ${command}`,
          ),
        );
      } else {
        resolve(result);
      }
    });
  });
}

async function prebuiltTree(
  root,
  triple,
  buildId,
  cli = "cli",
  runtime = "runtime",
) {
  const artifacts = path.join(root, `artifacts-${buildId}`);
  const tree = path.join(root, "prebuilt", triple);
  executable(path.join(artifacts, "hmux"), cli);
  executable(
    path.join(artifacts, "hmux-runtime"),
    structuredRuntimeFixture(runtime),
  );
  const result = await runArtifactSubprocess(
    "sh",
    ["scripts/package-hmux-prebuilt.sh", triple, tree],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        HMUX_ARTIFACT_DIR: artifacts,
        HMUX_BUILD_ID: buildId,
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr);
  }
  return tree;
}

// A PATH holding exactly the utilities the digest path needs and exactly one
// SHA-256 tool — or none. Shadowing with failing stubs would not do: the
// installer picks its tool with `command -v`, which finds a stub and reports
// success, so a stub tests the broken-tool case rather than the absent-tool
// case.
const DIGEST_PATH_UTILITIES = ["sh", "sed", "grep", "head", "cut", "uname"];

async function minimalToolDirectory(root, name, digestTool) {
  const directory = path.join(root, `toolbox-${name}`);
  fs.mkdirSync(directory, { recursive: true });
  const tools = digestTool
    ? [...DIGEST_PATH_UTILITIES, digestTool]
    : DIGEST_PATH_UTILITIES;
  for (const tool of tools) {
    const located = await runArtifactSubprocess("sh", [
      "-c",
      `command -v ${tool}`,
    ]);
    expect(located.status, `${tool} must exist to run this test`).toBe(0);
    fs.symlinkSync(located.stdout.trim(), path.join(directory, tool));
  }
  return directory;
}

async function availableDigestTools() {
  const available = [];
  for (const tool of ["sha256sum", "shasum", "openssl"]) {
    const located = await runArtifactSubprocess("sh", [
      "-c",
      `command -v ${tool}`,
    ]);
    if (located.status === 0) {
      available.push(tool);
    }
  }
  return available;
}

async function digestOf(tree, environment = {}) {
  const result = await runArtifactSubprocess(
    "sh",
    [installScript, "--print-prebuilt-digest"],
    {
      env: { ...process.env, HMUX_PREBUILT_DIR: tree, ...environment },
    },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr);
  }
  return result.stdout.trim();
}

async function install(root, tree, environment = {}) {
  const installRoot = path.join(root, "install");
  const commands = path.join(root, "commands");
  const result = await runArtifactSubprocess("sh", [installScript], {
    cwd: root,
    env: {
      HMUX_INSTALL_DIR: commands,
      HMUX_INSTALL_ROOT: installRoot,
      HMUX_PREBUILT_DIR: tree,
      HOME: root,
      PATH: process.env.PATH,
      ...environment,
    },
  });
  return { commands, installRoot, result };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("prebuilt Hmux artifact verification", () => {
  test(
    "packages traversable immutable directories with exact executable modes",
    async () => {
      const root = temporaryDirectory();
      const tree = await prebuiltTree(root, "test-target", "0.1.4+modes");

      expect(fs.statSync(tree).mode & 0o7777).toBe(0o755);
      expect(fs.statSync(path.join(tree, "bin")).mode & 0o7777).toBe(0o755);
      expect(fs.statSync(path.join(tree, "bin/hmux")).mode & 0o7777).toBe(
        0o755,
      );
      expect(fs.statSync(path.join(tree, "install.json")).mode & 0o7777).toBe(
        0o644,
      );
    },
    ARTIFACT_FIXTURE_TIMEOUT_MS,
  );

  test(
    "reproduces one digest for a tree regardless of the tool that hashes it",
    async () => {
      const root = temporaryDirectory();
      const tree = await prebuiltTree(
        root,
        "test-target",
        "0.1.4+digest",
      );

      // Every tool the installer knows how to fall back to has to agree, because
      // the pin is taken on a laptop with `shasum` and checked on an Alpine box
      // with busybox `sha256sum`. A per-tool digest would report every real
      // transfer as corrupted.
      const available = await availableDigestTools();

      expect(available.length).toBeGreaterThan(0);
      const digests = new Set(
        await Promise.all(
          available.map(async (tool) =>
            digestOf(tree, {
              PATH: await minimalToolDirectory(root, tool, tool),
            }),
          ),
        ),
      );
      expect(digests.size).toBe(1);
      expect([...digests][0]).toMatch(/^[0-9a-f]{64}$/);
    },
    ARTIFACT_FIXTURE_TIMEOUT_MS,
  );

  test(
    "an installed version directory hashes to the digest it was pinned at",
    async () => {
      const root = temporaryDirectory();
      const tree = await prebuiltTree(
        root,
        "test-target",
        "0.1.4+roundtrip",
      );
      const digest = await digestOf(tree);

      const { installRoot, result } = await install(root, tree, {
        HMUX_EXPECTED_DIGEST: digest,
      });

      expect(result.status, result.stderr).toBe(0);
      // Idempotence rests on this: provisioning re-hashes what is already on the
      // server and compares it to the pin for the artifact in hand. If an install
      // did not reproduce the digest of its source, every re-run would look like
      // a conflicting build.
      expect(
        await digestOf(
          path.join(installRoot, "versions/0.1.4+roundtrip"),
        ),
      ).toBe(digest);
    },
    ARTIFACT_FIXTURE_TIMEOUT_MS,
  );

  // Fails against the installer before this change, which had no digest step at
  // all: the corrupted tree installed cleanly and `current` moved onto it.
  test(
    "refuses a tree whose bytes do not match the pinned digest",
    async () => {
      const root = temporaryDirectory();
      const tree = await prebuiltTree(
        root,
        "test-target",
        "0.1.4+corrupt",
      );
      const pinned = await digestOf(tree);
      executable(path.join(tree, "bin/hmux"), "substituted-cli");

      const { installRoot, result } = await install(root, tree, {
        HMUX_EXPECTED_DIGEST: pinned,
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("digest does not match the pinned value");
      // The refusal has to land before anything becomes runnable, not after.
      expect(
        fs.existsSync(path.join(installRoot, "versions/0.1.4+corrupt")),
      ).toBe(false);
      expect(fs.existsSync(path.join(installRoot, "current"))).toBe(false);
    },
    ARTIFACT_FIXTURE_TIMEOUT_MS,
  );

  test(
    "refuses when no tool can compute the digest rather than skipping it",
    async () => {
      const root = temporaryDirectory();
      const tree = await prebuiltTree(
        root,
        "test-target",
        "0.1.4+notools",
      );
      const pinned = await digestOf(tree);

      const { installRoot, result } = await install(root, tree, {
        HMUX_EXPECTED_DIGEST: pinned,
        PATH: await minimalToolDirectory(root, "none", null),
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("no SHA-256 tool");
      expect(fs.existsSync(path.join(installRoot, "current"))).toBe(false);
    },
    ARTIFACT_FIXTURE_TIMEOUT_MS,
  );

  // The absent-tool and broken-tool cases fail in different places, and the
  // second one is the trap: a tool that exits 0 with empty output is selected
  // by `command -v` and then yields an empty digest, which without an explicit
  // check would be reported as a mismatched artifact and send the operator to
  // audit a server that is fine.
  test(
    "refuses a digest tool that returns nothing",
    async () => {
      const root = temporaryDirectory();
      const tree = await prebuiltTree(
        root,
        "test-target",
        "0.1.4+brokentool",
      );
      const pinned = await digestOf(tree);
      const toolbox = await minimalToolDirectory(root, "broken", null);
      executable(path.join(toolbox, "sha256sum"), "#!/bin/sh\nexit 0\n");

      const { installRoot, result } = await install(root, tree, {
        HMUX_EXPECTED_DIGEST: pinned,
        PATH: toolbox,
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("produced no usable digest");
      expect(fs.existsSync(path.join(installRoot, "current"))).toBe(false);
    },
    ARTIFACT_FIXTURE_TIMEOUT_MS,
  );

  test(
    "refuses a malformed pin instead of reading it as no pin",
    async () => {
      const root = temporaryDirectory();
      const tree = await prebuiltTree(
        root,
        "test-target",
        "0.1.4+malformed",
      );
      const pinned = await digestOf(tree);

      const { installRoot, result } = await install(root, tree, {
        HMUX_EXPECTED_DIGEST: `sha256:${pinned}`,
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("lowercase SHA-256 hex digest");
      expect(fs.existsSync(path.join(installRoot, "current"))).toBe(false);
    },
    ARTIFACT_FIXTURE_TIMEOUT_MS,
  );

  test(
    "refuses a pin with no artifact to check it against",
    async () => {
      const root = temporaryDirectory();
      const artifacts = path.join(root, "artifacts");
      executable(path.join(artifacts, "hmux"), "cli");
      executable(path.join(artifacts, "hmux-runtime"), "runtime");

      // A source build has nothing that was pinned at build time. Accepting the
      // variable and ignoring it would let a caller believe a build was verified
      // because it passed the pin along.
      const result = await runArtifactSubprocess("sh", [installScript], {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          CARGO_BUILD_TARGET: "test-target",
          HMUX_ARTIFACT_DIR: artifacts,
          HMUX_BUILD_ID: "0.1.4+unpinnable",
          HMUX_EXPECTED_DIGEST: "0".repeat(64),
          HMUX_INSTALL_DIR: path.join(root, "commands"),
          HMUX_INSTALL_ROOT: path.join(root, "install"),
          HMUX_SKIP_BUILD: "1",
          HOME: root,
        },
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("requires HMUX_PREBUILT_DIR");
    },
    ARTIFACT_FIXTURE_TIMEOUT_MS,
  );

  test(
    "a matching pin leaves the install path otherwise unchanged",
    async () => {
      const root = temporaryDirectory();
      const tree = await prebuiltTree(
        root,
        "test-target",
        "0.1.4+pinned",
        "cli-bytes",
      );

      const { commands, installRoot, result } = await install(root, tree, {
        HMUX_EXPECTED_DIGEST: await digestOf(tree),
      });

      expect(result.status, result.stderr).toBe(0);
      expect(
        fs.readFileSync(
          path.join(installRoot, "versions/0.1.4+pinned/bin/hmux"),
          "utf8",
        ),
      ).toBe("cli-bytes");
      expect(fs.readlinkSync(path.join(installRoot, "current"))).toBe(
        "versions/0.1.4+pinned",
      );
      expect(fs.realpathSync(path.join(commands, "hmux"))).toBe(
        fs.realpathSync(
          path.join(installRoot, "versions/0.1.4+pinned/bin/hmux"),
        ),
      );
    },
    ARTIFACT_FIXTURE_TIMEOUT_MS,
  );
});
