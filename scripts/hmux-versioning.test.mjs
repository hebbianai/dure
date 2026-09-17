import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import {
  applyVersionPrune,
  defaultDiscoveryRoots,
  planVersionPrune,
} from "./lib/hmux-version-gc.mjs";
import { computeHmuxDevBuildId } from "./hmux-dev-build-id.mjs";
import { HMUX_DEV_RUNTIME_INPUTS } from "./lib/hmux-dev-build-inputs.mjs";
import { hmuxDevRuntimeStageRequired } from "./lib/dev-launch-impact.mjs";

const temporaryDirectories = [];
const execFileAsync = promisify(execFile);
const pruneHmuxVersionsScript = fileURLToPath(
  new URL("./prune-hmux-versions.mjs", import.meta.url),
);

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hmux-versioning-"));
  temporaryDirectories.push(directory);
  return directory;
}

function executable(pathname, contents) {
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  fs.writeFileSync(pathname, contents, { mode: 0o755 });
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function structuredRuntimeFixture(contents) {
  return `#!/bin/sh
# hmux-product-profile=structured-terminal-v1
if [ "\${1:-}" = "--no-autostart" ] &&
  [ "\${2:-}" = "hmux-build-info" ]; then
  printf '%s\\n' '{"productProfile":"structured-terminal-v1"}'
  exit 0
fi
printf '%s' ${shellQuote(contents)}
`;
}

function agentToolBuildFixture(root) {
  const tools = path.join(root, "tools");
  const ghosttyProof = path.join(root, "ghostty-proof");
  fs.mkdirSync(ghosttyProof, { recursive: true });
  fs.writeFileSync(
    path.join(ghosttyProof, "hmux-ghostty-vt-proof.receipt"),
    "fixture receipt validated by the real Cargo build boundary\n",
  );
  const prepareCapture = path.join(root, "prepare-target");
  const prepareInstallRootCapture = path.join(root, "prepare-install-root");
  const prepareCommandDirectoryCapture = path.join(
    root,
    "prepare-command-directory",
  );
  const prepareArtifactDirectoryCapture = path.join(
    root,
    "prepare-artifact-directory",
  );
  const stageCapture = path.join(root, "stage-target");
  const stageArgsCapture = path.join(root, "stage-args");
  const prepareSkipBuildCapture = path.join(root, "prepare-skip-build");
  const shellCapture = path.join(root, "shell-invocations");
  executable(
    path.join(tools, "node"),
    `#!/bin/sh
if [ "$1" = "scripts/hmux-dev-build-id.mjs" ]; then
  printf '%s\\n' "\${PREPARE_BUILD_ID:-0.1.4+dev.fixture.context}"
elif [ "$1" = "scripts/resolve-dev-app-channel.mjs" ]; then
  printf '%s\\n' "\${PREPARE_CHANNEL:-dev-fixture-a1b2c3d4}"
elif [ "\${1##*/}" = "verify-hmux-dev-activation.mjs" ] ||
     [ "\${1##*/}" = "native-build-slot.mjs" ]; then
  exec ${shellQuote(process.execPath)} "$@"
elif [ "\${1##*/}" = "dev-agent-tools-current.mjs" ]; then
  [ "\${4:-}" = "--verify" ] && [ -f "$HOME/cli-prepared-$2" ]
  exit $?
elif [ "$1" = "scripts/install-dure-cli.mjs" ]; then
  printf '%s' "$DURE_APP_CHANNEL" >"$HOME/cli-prepared-$DURE_APP_CHANNEL"
fi
`,
  );
  executable(
    path.join(tools, "sh"),
    `#!/bin/sh
printf '%s\n' "\${1:-}" >>"$SHELL_CAPTURE"
case "\${1:-}" in
  scripts/install-hmux.sh | */scripts/install-hmux.sh) ;;
  *) exec /bin/sh "$@" ;;
esac
printf '%s' "$CARGO_TARGET_DIR" >"$PREPARE_CAPTURE"
printf '%s' "\${HMUX_ARTIFACT_DIR:-}" >"$PREPARE_ARTIFACT_DIRECTORY_CAPTURE"
printf '%s' "\${HMUX_SKIP_BUILD:-}" >"$PREPARE_SKIP_BUILD_CAPTURE"
install_root=\${HMUX_INSTALL_ROOT:-"$HOME/.local/share/hmux"}
command_directory=\${HMUX_INSTALL_DIR:-"$HOME/.local/bin"}
case "$install_root" in
  "$HOME"/.local/share/hmux/channels/*) ;;
  *) exit 24 ;;
esac
[ "$command_directory" = "$install_root/bin" ] || exit 24
printf '%s' "$install_root" >"$PREPARE_INSTALL_ROOT_CAPTURE"
printf '%s' "$command_directory" >"$PREPARE_COMMAND_DIRECTORY_CAPTURE"
version_bin="$install_root/versions/$HMUX_BUILD_ID/bin"
mkdir -p "$version_bin" "$command_directory"
if [ "\${PREPARE_FAIL_BEFORE_ACTIVATION:-0}" = "1" ]; then
  exit 23
fi
cat >"$version_bin/hmux" <<HMUX
#!/bin/sh
cat <<JSON
{
  "buildInfo": {
    "buildId": "$HMUX_BUILD_ID",
    "source": "hmux_cli"
  },
  "schemaVersion": 2
}
JSON
HMUX
cat >"$version_bin/hmux-runtime" <<RUNTIME
#!/bin/sh
cat <<JSON
{
  "buildId": "$HMUX_BUILD_ID",
  "schemaVersion": 1,
  "source": "hmux_runtime"
}
JSON
RUNTIME
chmod 755 "$version_bin/hmux" "$version_bin/hmux-runtime"
rm -f "$install_root/current"
ln -s "versions/$HMUX_BUILD_ID" "$install_root/current"
rm -f "$command_directory/hmux"
ln -s "$install_root/current/bin/hmux" "$command_directory/hmux"
`,
  );
  executable(
    path.join(tools, "cargo"),
    `#!/bin/sh
printf '%s' "$CARGO_TARGET_DIR" >"$STAGE_CAPTURE"
printf '%s' "$*" >"$STAGE_ARGS_CAPTURE"
artifact_directory="$CARGO_TARGET_DIR"
if [ -n "$CARGO_BUILD_TARGET" ]; then
  artifact_directory="$artifact_directory/$CARGO_BUILD_TARGET"
fi
mkdir -p "$artifact_directory/debug"
cat >"$artifact_directory/debug/hmux-runtime" <<'RUNTIME'
#!/bin/sh
# hmux-product-profile=structured-terminal-v1
if [ "\${1:-}" = "--no-autostart" ] &&
  [ "\${2:-}" = "hmux-build-info" ]; then
  printf '%s\\n' '{"productProfile":"structured-terminal-v1"}'
  exit 0
fi
printf '%s' 'fixture-runtime'
RUNTIME
chmod 755 "$artifact_directory/debug/hmux-runtime"
# 사이드카는 둘이다. hmux 는 설정 화면의 QR 페어링이 부르는 CLI이고,
# debug 프로파일은 원래부터 이 패키지를 빌드하고 있었다 (복사만 안 했다).
# 백틱을 쓰지 않는다: 이 문자열은 템플릿 리터럴 안이라 백틱이 그것을 끊는다.
printf '%s' 'fixture-cli' >"$artifact_directory/debug/hmux"
chmod 755 "$artifact_directory/debug/hmux"
`,
  );
  return {
    environment: {
      ...process.env,
      CARGO_BUILD_TARGET: "fixture-target",
      CARGO_TARGET_DIR: path.join(root, "cargo-target"),
      DURE_POSIX_SHELL: path.join(tools, "sh"),
      DURE_NATIVE_BUILD_SLOT_ROOT: path.join(root, "build-slot"),
      HOME: root,
      HMUX_GHOSTTY_VT_PROOF_PREFIX: ghosttyProof,
      PATH: `${tools}${path.delimiter}${process.env.PATH}`,
      PREPARE_CAPTURE: prepareCapture,
      PREPARE_ARTIFACT_DIRECTORY_CAPTURE: prepareArtifactDirectoryCapture,
      PREPARE_COMMAND_DIRECTORY_CAPTURE: prepareCommandDirectoryCapture,
      PREPARE_INSTALL_ROOT_CAPTURE: prepareInstallRootCapture,
      PREPARE_SKIP_BUILD_CAPTURE: prepareSkipBuildCapture,
      SHELL_CAPTURE: shellCapture,
      STAGE_ARGS_CAPTURE: stageArgsCapture,
      STAGE_CAPTURE: stageCapture,
    },
    prepareCommandDirectoryCapture,
    prepareArtifactDirectoryCapture,
    prepareCapture,
    prepareInstallRootCapture,
    prepareSkipBuildCapture,
    shellCapture,
    stageArgsCapture,
    stageCapture,
  };
}

function devBuildFixture(root) {
  fs.mkdirSync(path.join(root, "hmux"), { recursive: true });
  fs.mkdirSync(path.join(root, "crates/hebbian-process-sampler"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(root, "hmux/Cargo.toml"),
    '[workspace]\n[workspace.package]\nversion = "0.1.4"\n',
  );
  fs.writeFileSync(path.join(root, "hmux/source.rs"), "fn main() {}\n");
  fs.writeFileSync(
    path.join(root, "crates/hebbian-process-sampler/source.rs"),
    "pub fn sample() {}\n",
  );
  for (const input of HMUX_DEV_RUNTIME_INPUTS) {
    if (input.recursive) continue;
    const pathname = path.join(root, input.path);
    fs.mkdirSync(path.dirname(pathname), { recursive: true });
    fs.writeFileSync(
      pathname,
      input.path === "rust-toolchain.toml"
        ? fs.readFileSync(path.resolve("rust-toolchain.toml"))
        : `${input.path}\n`,
    );
  }
}

function installFixture(
  root,
  buildId,
  cliContents,
  runtimeContents,
  profile = "release",
  shellUmask,
) {
  const artifacts = path.join(root, "artifacts");
  const commands = path.join(root, "commands");
  const installRoot = path.join(root, "install");
  executable(path.join(artifacts, "hmux"), cliContents);
  executable(
    path.join(artifacts, "hmux-runtime"),
    structuredRuntimeFixture(runtimeContents),
  );
  const installScript = path.resolve("scripts/install-hmux.sh");
  const installArguments = shellUmask
    ? ["-c", `umask ${shellUmask}; exec sh "$1"`, "hmux-install", installScript]
    : [installScript];
  execFileSync("sh", installArguments, {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      CARGO_BUILD_TARGET: "test-target",
      HOME: root,
      HMUX_ARTIFACT_DIR: artifacts,
      HMUX_BUILD_ID: buildId,
      HMUX_INSTALL_DIR: commands,
      HMUX_INSTALL_ROOT: installRoot,
      HMUX_PROFILE: profile,
      HMUX_SKIP_BUILD: "1",
    },
    stdio: "pipe",
  });
  return { commands, installRoot };
}

function sourceInstallBuildFixture(root) {
  const tools = path.join(root, "tools");
  const target = path.join(root, "target");
  const buildArguments = path.join(root, "cargo-build-arguments");
  const proof = path.join(root, "ghostty-proof");
  fs.mkdirSync(proof, { recursive: true });
  fs.writeFileSync(
    path.join(proof, "hmux-ghostty-vt-proof.receipt"),
    "fixture receipt validated by the real Cargo build boundary\n",
  );
  executable(
    path.join(tools, "cargo"),
    `#!/bin/sh
printf '%s\n' "$*" >"$HMUX_TEST_BUILD_ARGUMENTS"
artifact_directory="$CARGO_TARGET_DIR/$CARGO_BUILD_TARGET/release"
mkdir -p "$artifact_directory"
printf '%s\n' 'hmux fixture' >"$artifact_directory/hmux"
chmod 755 "$artifact_directory/hmux"
cat >"$artifact_directory/hmux-runtime" <<'RUNTIME'
#!/bin/sh
# hmux-product-profile=structured-terminal-v1
if [ "\${1:-}" = "--no-autostart" ] &&
  [ "\${2:-}" = "hmux-build-info" ]; then
  printf '%s\\n' '{"productProfile":"structured-terminal-v1"}'
  exit 0
fi
printf '%s\\n' 'hmux-runtime fixture'
RUNTIME
chmod 755 "$artifact_directory/hmux-runtime"
`,
  );
  execFileSync("sh", [path.resolve("scripts/install-hmux.sh")], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      CARGO_BUILD_TARGET: "aarch64-apple-darwin",
      CARGO_TARGET_DIR: target,
      HOME: root,
      HMUX_BUILD_ID: "0.1.4+structured-source-fixture",
      HMUX_GHOSTTY_VT_PROOF_PREFIX: proof,
      HMUX_INSTALL_DIR: path.join(root, "commands"),
      HMUX_INSTALL_ROOT: path.join(root, "install"),
      HMUX_TEST_BUILD_ARGUMENTS: buildArguments,
      DURE_NATIVE_BUILD_SLOT_ROOT: path.join(root, "build-slot"),
      PATH: `${tools}${path.delimiter}${process.env.PATH}`,
    },
    stdio: "pipe",
  });
  return fs.readFileSync(buildArguments, "utf8").trim();
}

function machODevRebuildFixture(root) {
  const source = path.join(root, "fixture.c");
  const firstObject = path.join(root, "first-random-name.rcgu.o");
  const secondObject = path.join(root, "other-random-name.rcgu.o");
  const first = path.join(root, "first/hmux");
  const second = path.join(root, "second/hmux");
  fs.writeFileSync(
    source,
    `#include <stdio.h>
#include <string.h>
int main(int argc, char **argv) {
  if (argc == 3 && strcmp(argv[1], "--no-autostart") == 0 &&
      strcmp(argv[2], "hmux-build-info") == 0) {
    puts("{\\\"productProfile\\\":\\\"structured-terminal-v1\\\"}");
  }
  return 0;
}
`,
  );
  fs.mkdirSync(path.dirname(first), { recursive: true });
  fs.mkdirSync(path.dirname(second), { recursive: true });
  execFileSync("/usr/bin/clang", ["-g", "-c", source, "-o", firstObject]);
  fs.copyFileSync(firstObject, secondObject);
  execFileSync("/usr/bin/clang", [
    "-g",
    firstObject,
    "-o",
    first,
  ]);
  execFileSync("/usr/bin/clang", [
    "-g",
    secondObject,
    "-o",
    second,
  ]);
  return [first, second];
}

function prebuiltFixture(
  root,
  buildId,
  targetTriple,
  cliContents,
  runtimeContents,
) {
  const artifacts = path.join(root, "artifacts");
  const tree = path.join(root, "prebuilt", targetTriple);
  executable(path.join(artifacts, "hmux"), cliContents);
  executable(
    path.join(artifacts, "hmux-runtime"),
    structuredRuntimeFixture(runtimeContents),
  );
  execFileSync("sh", ["scripts/package-hmux-prebuilt.sh", targetTriple, tree], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      HMUX_ARTIFACT_DIR: artifacts,
      HMUX_BUILD_ID: buildId,
    },
    stdio: "pipe",
  });
  return tree;
}

// A provisioned server has an artifact and nothing else. Running from an empty
// directory with git and rustc replaced by failing shims is what makes this a
// test of that machine rather than of the developer's checkout.
function installPrebuiltFixture(root, tree, environment = {}) {
  const shims = path.join(root, "shims");
  executable(path.join(shims, "git"), "#!/bin/sh\nexit 127\n");
  executable(path.join(shims, "rustc"), "#!/bin/sh\nexit 127\n");
  const bare = path.join(root, "bare");
  const commands = path.join(root, "commands");
  const installRoot = path.join(root, "install");
  fs.mkdirSync(bare, { recursive: true });
  execFileSync("sh", [path.resolve("scripts/install-hmux.sh")], {
    cwd: bare,
    env: {
      HMUX_INSTALL_DIR: commands,
      HMUX_INSTALL_ROOT: installRoot,
      HMUX_PREBUILT_DIR: tree,
      HOME: root,
      PATH: `${shims}${path.delimiter}${process.env.PATH}`,
      ...environment,
    },
    stdio: "pipe",
  });
  return { commands, installRoot };
}

function installedVersion(installRoot, buildId, modifiedMs) {
  const directory = path.join(installRoot, "versions", buildId);
  fs.mkdirSync(path.join(directory, "bin"), { recursive: true });
  fs.writeFileSync(
    path.join(directory, "install.json"),
    JSON.stringify({ schemaVersion: 1, buildId }),
  );
  const modified = new Date(modifiedMs);
  fs.utimesSync(directory, modified, modified);
  return directory;
}

function readyManifest(buildId, processId) {
  return {
    lifecycle: "ready",
    manifest: {
      common: {
        host_build_version: buildId,
        host_process: { process_id: processId, start_marker: "start" },
      },
    },
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// 실 파일시스템·git·스테이징 스크립트를 도는 테스트들 — 러너/개발기 부하에서
// 기본 5s를 스치듯 넘긴다(2026-07-29 pre-push 2회 실측: 같은 트리가 한산할 땐
// 통과). release-workflow-boundary와 같은 처방으로 여유 한도를 준다.
describe("immutable Hmux installation", { timeout: 20_000 }, () => {
  test("source installation builds the structured product runtime", () => {
    const arguments_ = sourceInstallBuildFixture(temporaryDirectory());

    expect(arguments_).toContain("--package hmux-runtime");
    expect(arguments_).toContain(
      "--features hmux-runtime/terminal-state-stream",
    );
  });

  test("refuses a feature-dark runtime from the explicit artifact reuse path", () => {
    const root = temporaryDirectory();
    const artifacts = path.join(root, "artifacts");
    executable(path.join(artifacts, "hmux"), "#!/bin/sh\nexit 0\n");
    executable(
      path.join(artifacts, "hmux-runtime"),
      `#!/bin/sh
# hmux-product-profile=runtime-core-v1
if [ "\${1:-}" = "--no-autostart" ] &&
  [ "\${2:-}" = "hmux-build-info" ]; then
  printf '%s\\n' '{"productProfile":"runtime-core-v1"}'
  exit 0
fi
exit 0
`,
    );

    expect(() =>
      execFileSync("sh", [path.resolve("scripts/install-hmux.sh")], {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          CARGO_BUILD_TARGET: "test-target",
          HOME: root,
          HMUX_ARTIFACT_DIR: artifacts,
          HMUX_BUILD_ID: "0.1.4+feature-dark",
          HMUX_INSTALL_DIR: path.join(root, "commands"),
          HMUX_INSTALL_ROOT: path.join(root, "install"),
          HMUX_PROFILE: "release",
          HMUX_SKIP_BUILD: "1",
        },
        stdio: "pipe",
      }),
    ).toThrow();
    expect(fs.existsSync(path.join(root, "install/current"))).toBe(false);
  });

  test("normalizes store directories under a group-writable caller umask", () => {
    const root = temporaryDirectory();
    const installed = installFixture(
      root,
      "0.1.4+umask",
      "cli",
      "runtime",
      "release",
      "002",
    );
    const version = path.join(
      installed.installRoot,
      "versions",
      "0.1.4+umask",
    );

    for (const directory of [
      installed.installRoot,
      path.join(installed.installRoot, "versions"),
      version,
      path.join(version, "bin"),
    ]) {
      expect(fs.statSync(directory).mode & 0o022).toBe(0);
    }
    for (const file of [
      path.join(version, "install.json"),
      path.join(version, "bin", "hmux"),
      path.join(version, "bin", "hmux-runtime"),
    ]) {
      expect(fs.statSync(file).mode & 0o022).toBe(0);
    }

    for (const [pathToWiden, unsafeBits] of [
      [version, 0o020],
      [path.join(version, "bin"), 0o002],
    ]) {
      fs.chmodSync(pathToWiden, fs.statSync(pathToWiden).mode | unsafeBits);
    }
    installFixture(
      root,
      "0.1.4+umask",
      "cli",
      "runtime",
      "release",
      "002",
    );
    for (const pathToCheck of [
      installed.installRoot,
      path.join(installed.installRoot, "versions"),
      version,
      path.join(version, "bin"),
      path.join(version, "install.json"),
      path.join(version, "bin", "hmux"),
      path.join(version, "bin", "hmux-runtime"),
    ]) {
      expect(fs.statSync(pathToCheck).mode & 0o022).toBe(0);
    }
  });

  test("refuses writable immutable files instead of blessing their open descriptors", () => {
    for (const [relativeFile, unsafeBits] of [
      ["install.json", 0o020],
      ["bin/hmux", 0o002],
      ["bin/hmux-runtime", 0o022],
    ]) {
      const root = temporaryDirectory();
      const installed = installFixture(
        root,
        `0.1.4+writable-${path.basename(relativeFile)}`,
        "cli",
        "runtime",
      );
      const file = path.join(
        installed.installRoot,
        "versions",
        `0.1.4+writable-${path.basename(relativeFile)}`,
        relativeFile,
      );
      fs.chmodSync(file, fs.statSync(file).mode | unsafeBits);

      expect(() =>
        installFixture(
          root,
          `0.1.4+writable-${path.basename(relativeFile)}`,
          "cli",
          "runtime",
        ),
      ).toThrow();
      expect(fs.statSync(file).mode & 0o022).toBe(unsafeBits);
    }
  });

  test("refuses mode migration through a hard-linked immutable file", () => {
    const root = temporaryDirectory();
    const installed = installFixture(
      root,
      "0.1.4+hard-link",
      "cli",
      "runtime",
    );
    const cli = path.join(
      installed.installRoot,
      "versions/0.1.4+hard-link/bin/hmux",
    );
    fs.linkSync(cli, path.join(root, "outside-cli"));
    fs.chmodSync(cli, 0o775);

    expect(() =>
      installFixture(
        root,
        "0.1.4+hard-link",
        "cli",
        "runtime",
      ),
    ).toThrow();
    expect(fs.statSync(path.join(root, "outside-cli")).mode & 0o022).toBe(
      0o020,
    );
  });

  test("switches current atomically while preserving the previous build", () => {
    const root = temporaryDirectory();
    executable(path.join(root, "commands/hmux"), "legacy-command");
    const first = installFixture(root, "0.1.0+build-a", "cli-a", "runtime-a");
    const second = installFixture(root, "0.1.0+build-b", "cli-b", "runtime-b");

    expect(second).toEqual(first);
    expect(
      fs.readFileSync(
        path.join(first.installRoot, "rollback/pre-versioned/bin/hmux"),
        "utf8",
      ),
    ).toBe("legacy-command");
    expect(
      fs.readFileSync(
        path.join(first.installRoot, "versions/0.1.0+build-a/bin/hmux"),
        "utf8",
      ),
    ).toBe("cli-a");
    expect(
      fs.readFileSync(
        path.join(first.installRoot, "versions/0.1.0+build-b/bin/hmux"),
        "utf8",
      ),
    ).toBe("cli-b");
    expect(fs.readlinkSync(path.join(first.installRoot, "current"))).toBe(
      "versions/0.1.0+build-b",
    );
    expect(fs.realpathSync(path.join(first.commands, "hmux"))).toBe(
      fs.realpathSync(
        path.join(first.installRoot, "versions/0.1.0+build-b/bin/hmux"),
      ),
    );
  });

  test("never overwrites a build id with different bytes", () => {
    const root = temporaryDirectory();
    installFixture(root, "0.1.0+same", "cli-a", "runtime-a");

    expect(() =>
      installFixture(root, "0.1.0+same", "cli-changed", "runtime-a"),
    ).toThrow();
    expect(fs.existsSync(path.join(root, "install/.mutation-lock"))).toBe(false);
    expect(() =>
      installFixture(root, "0.1.0+same", "cli-a", "runtime-a"),
    ).not.toThrow();
  });

  test("records a developer profile without colliding with release artifacts", () => {
    const root = temporaryDirectory();
    const installed = installFixture(
      root,
      "0.1.4+dev.fixture",
      "debug-cli",
      "debug-runtime",
      "debug",
    );
    const metadata = JSON.parse(
      fs.readFileSync(
        path.join(
          installed.installRoot,
          "versions/0.1.4+dev.fixture/install.json",
        ),
        "utf8",
      ),
    );

    expect(metadata).toMatchObject({
      buildId: "0.1.4+dev.fixture",
      profile: "debug",
    });
  });
});

describe("prebuilt Hmux installation", { timeout: 20_000 }, () => {
  const hostMachine = execFileSync("uname", ["-m"], {
    encoding: "utf8",
  }).trim();
  const recognizedMachine = ["x86_64", "amd64", "aarch64", "arm64"].includes(
    hostMachine,
  );
  const foreignMachine = ["x86_64", "amd64"].includes(hostMachine)
    ? "aarch64"
    : "x86_64";

  test("installs on a machine with neither a checkout nor a toolchain", () => {
    const root = temporaryDirectory();
    const tree = prebuiltFixture(
      root,
      "0.1.4+prebuilt",
      "test-target",
      "prebuilt-cli",
      "prebuilt-runtime",
    );

    const installed = installPrebuiltFixture(root, tree);

    expect(
      fs.readFileSync(
        path.join(installed.installRoot, "versions/0.1.4+prebuilt/bin/hmux"),
        "utf8",
      ),
    ).toBe("prebuilt-cli");
    expect(fs.readlinkSync(path.join(installed.installRoot, "current"))).toBe(
      "versions/0.1.4+prebuilt",
    );
    expect(fs.realpathSync(path.join(installed.commands, "hmux-runtime"))).toBe(
      fs.realpathSync(
        path.join(
          installed.installRoot,
          "versions/0.1.4+prebuilt/bin/hmux-runtime",
        ),
      ),
    );
    // The artifact declares its own identity and the install must reproduce it
    // exactly: the installer re-emits this manifest and later greps it to
    // enforce immutability, so a format drift between the two scripts is a
    // corrupted store rather than a cosmetic diff.
    expect(
      fs.readFileSync(
        path.join(installed.installRoot, "versions/0.1.4+prebuilt/install.json"),
        "utf8",
      ),
    ).toBe(fs.readFileSync(path.join(tree, "install.json"), "utf8"));
  });

  test.skipIf(!recognizedMachine)(
    "refuses an artifact built for another machine",
    () => {
      const root = temporaryDirectory();
      const tree = prebuiltFixture(
        root,
        "0.1.4+foreign",
        `${foreignMachine}-unknown-testos`,
        "foreign-cli",
        "foreign-runtime",
      );

      expect(() => installPrebuiltFixture(root, tree)).toThrow();
      expect(fs.existsSync(path.join(root, "install/current"))).toBe(false);
    },
  );

  test("refuses a build id that disagrees with the artifact", () => {
    const root = temporaryDirectory();
    const tree = prebuiltFixture(
      root,
      "0.1.4+declared",
      "test-target",
      "cli",
      "runtime",
    );

    expect(() =>
      installPrebuiltFixture(root, tree, { HMUX_BUILD_ID: "0.1.4+renamed" }),
    ).toThrow();
    expect(fs.existsSync(path.join(root, "install/versions/0.1.4+renamed"))).toBe(
      false,
    );
  });

  test("refuses to package a Linux artifact that is not a static ELF", () => {
    const root = temporaryDirectory();

    expect(() =>
      prebuiltFixture(
        root,
        "0.1.4+notelf",
        "x86_64-unknown-linux-musl",
        "#!/bin/sh\nexit 0\n",
        "#!/bin/sh\nexit 0\n",
      ),
    ).toThrow();
    expect(
      fs.existsSync(path.join(root, "prebuilt/x86_64-unknown-linux-musl")),
    ).toBe(false);
  });
});

describe("developer Hmux build identity", { timeout: 20_000 }, () => {
  const fixedBuildContext = {
    environment: {},
    rustcVersion: "rustc 1.88.0 (fixture)\nhost: fixture-target",
  };

  test("is stable for repeated builds in one canonical worktree", () => {
    const root = temporaryDirectory();
    devBuildFixture(root);

    expect(
      computeHmuxDevBuildId({
        repositoryRoot: root,
        ...fixedBuildContext,
      }),
    ).toBe(
      computeHmuxDevBuildId({
        repositoryRoot: root,
        ...fixedBuildContext,
      }),
    );
  });

  test("probes the compiler from the canonical target worktree", () => {
    const root = temporaryDirectory();
    devBuildFixture(root);
    const environment = { RUSTUP_TOOLCHAIN: "fixture" };
    let invocation;

    computeHmuxDevBuildId({
      repositoryRoot: root,
      environment,
      run: (command, args, options) => {
        invocation = { command, args, options };
        return "rustc 1.88.0 (fixture)\nhost: fixture-target\n";
      },
    });

    expect(invocation).toEqual({
      command: "rustc",
      args: ["-vV"],
      options: {
        cwd: fs.realpathSync(root),
        encoding: "utf8",
        env: environment,
        maxBuffer: 64 * 1024,
        timeout: 10_000,
      },
    });
  });

  test.runIf(process.platform !== "win32")(
    "bounds a stalled compiler identity probe",
    () => {
      const root = temporaryDirectory();
      devBuildFixture(root);
      const bin = path.join(root, "fixture-bin");
      const rustc = path.join(bin, "rustc");
      fs.mkdirSync(bin);
      fs.writeFileSync(rustc, "#!/bin/sh\nsleep 10\n");
      fs.chmodSync(rustc, 0o700);
      const startedAtMs = Date.now();

      expect(() =>
        computeHmuxDevBuildId({
          repositoryRoot: root,
          environment: { PATH: bin },
          rustcTimeoutMs: 50,
        }),
      ).toThrow();
      expect(Date.now() - startedAtMs).toBeLessThan(2_000);
    },
  );

  test("separates byte-different debug artifacts from distinct worktrees", () => {
    const firstRoot = temporaryDirectory();
    const secondRoot = temporaryDirectory();
    devBuildFixture(firstRoot);
    devBuildFixture(secondRoot);

    const first = computeHmuxDevBuildId({
      repositoryRoot: firstRoot,
      ...fixedBuildContext,
    });
    const second = computeHmuxDevBuildId({
      repositoryRoot: secondRoot,
      ...fixedBuildContext,
    });

    expect(first).toMatch(/^0\.1\.4\+dev\.[a-f0-9]{16}\.[a-f0-9]{12}$/);
    expect(first.split(".").at(-2)).toBe(second.split(".").at(-2));
    expect(first).not.toBe(second);
  });

  test.each([
    { RUSTFLAGS: "-C force-frame-pointers=yes" },
    { CARGO_BUILD_BUILD_DIR: "hmux/target/custom-build" },
  ])("separates compiler inputs that can change artifact bytes (%j)", environment => {
    const root = temporaryDirectory();
    devBuildFixture(root);
    const base = computeHmuxDevBuildId({
      repositoryRoot: root,
      ...fixedBuildContext,
    });

    expect(
      computeHmuxDevBuildId({
        repositoryRoot: root,
        ...fixedBuildContext,
        environment,
      }),
    ).not.toBe(base);
  });

  test("reuses one build identity when only the repository revision changes", () => {
    const root = temporaryDirectory();
    devBuildFixture(root);
    const base = computeHmuxDevBuildId({
      repositoryRoot: root,
      ...fixedBuildContext,
      gitRevision: "a".repeat(40),
    });

    expect(
      computeHmuxDevBuildId({
        repositoryRoot: root,
        ...fixedBuildContext,
        gitRevision: "b".repeat(40),
      }),
    ).toBe(base);
  });

  test("separates changes to Hmux source bytes", () => {
    const root = temporaryDirectory();
    devBuildFixture(root);
    const base = computeHmuxDevBuildId({
      repositoryRoot: root,
      ...fixedBuildContext,
    });

    fs.writeFileSync(
      path.join(root, "hmux/source.rs"),
      'fn main() { println!("changed"); }\n',
    );

    expect(
      computeHmuxDevBuildId({
        repositoryRoot: root,
        ...fixedBuildContext,
      }),
    ).not.toBe(base);
  });

  test("keeps deploy policy outside the Hmux build identity", () => {
    const root = temporaryDirectory();
    devBuildFixture(root);
    const deployPolicy = path.join(root, "scripts/lib/dev-launch-impact.mjs");
    fs.mkdirSync(path.dirname(deployPolicy), { recursive: true });
    fs.writeFileSync(deployPolicy, "initial deploy policy\n");
    const base = computeHmuxDevBuildId({
      repositoryRoot: root,
      ...fixedBuildContext,
    });

    fs.appendFileSync(deployPolicy, "deploy policy changed\n");

    expect(
      computeHmuxDevBuildId({
        repositoryRoot: root,
        ...fixedBuildContext,
      }),
    ).toBe(base);
    expect(
      hmuxDevRuntimeStageRequired(["scripts/lib/dev-launch-impact.mjs"]),
    ).toBe(false);
  });

  test("separates every build recipe input that requires runtime staging", () => {
    const root = temporaryDirectory();
    devBuildFixture(root);
    const base = computeHmuxDevBuildId({
      repositoryRoot: root,
      ...fixedBuildContext,
    });

    for (const input of HMUX_DEV_RUNTIME_INPUTS.filter(
      (candidate) => !candidate.recursive,
    )) {
      const pathname = path.join(root, input.path);
      const original = fs.readFileSync(pathname);
      fs.appendFileSync(pathname, "changed\n");
      expect(
        computeHmuxDevBuildId({
          repositoryRoot: root,
          ...fixedBuildContext,
        }),
        input.path,
      ).not.toBe(base);
      expect(hmuxDevRuntimeStageRequired([input.path]), input.path).toBe(true);
      fs.writeFileSync(pathname, original);
    }
  });

  test("agent preparation keeps app runtime staging untouched", () => {
    const root = temporaryDirectory();
    const fixture = agentToolBuildFixture(root);
    const repositoryRoot = path.resolve(".");
    const appRuntimeDirectory = path.join(root, "src-tauri/binaries");
    const appRuntime = path.join(
      appRuntimeDirectory,
      "hmux-runtime-fixture-target",
    );
    const appCli = path.join(appRuntimeDirectory, "hmux-fixture-target");
    fs.mkdirSync(appRuntimeDirectory, { recursive: true });
    fs.writeFileSync(appRuntime, "active-app-runtime");
    fs.writeFileSync(appCli, "active-app-cli");

    execFileSync(
      "/bin/sh",
      [path.join(repositoryRoot, "scripts/prepare-agent-tools.sh")],
      {
        cwd: root,
        env: {
          ...fixture.environment,
          HEBBIAN_APP_CHANNEL: "dev-inherited-wrong-a1b2c3d4",
          HMUX_INSTALL_DIR: path.join(root, ".local/bin"),
          HMUX_INSTALL_ROOT: path.join(root, ".local/share/hmux"),
          PREPARE_CHANNEL: "dev-fixture-a1b2c3d4",
        },
        stdio: "pipe",
      },
    );
    const expectedTarget = path.join(
      root,
      "cargo-target/agent-tools/0.1.4+dev.fixture.context",
    );
    expect(fs.readFileSync(fixture.prepareCapture, "utf8")).toBe(expectedTarget);
    expect(
      fs
        .readFileSync(fixture.shellCapture, "utf8")
        .trim()
        .split("\n")
        .map((pathname) => path.basename(pathname)),
    ).toEqual([
      "prepare-hmux-dev-tools.sh",
      "stage-hmux-runtime.sh",
      "build-hmux-product-runtime.sh",
      "with-hmux-build-environment.sh",
      "verify-hmux-product-runtime.sh",
      "install-hmux.sh",
    ]);
    const privateArtifactDirectory = fs.readFileSync(
      fixture.prepareArtifactDirectoryCapture,
      "utf8",
    );
    expect(
      privateArtifactDirectory.startsWith(`${expectedTarget}/.stage.`),
    ).toBe(true);
    expect(fs.existsSync(privateArtifactDirectory)).toBe(false);
    const expectedInstallRoot = path.join(
      root,
      ".local/share/hmux/channels/dev-fixture-a1b2c3d4",
    );
    expect(
      fs.readFileSync(fixture.prepareInstallRootCapture, "utf8"),
    ).toBe(expectedInstallRoot);
    expect(
      fs.readFileSync(fixture.prepareCommandDirectoryCapture, "utf8"),
    ).toBe(path.join(expectedInstallRoot, "bin"));
    expect(fs.readFileSync(fixture.stageCapture, "utf8")).toBe(expectedTarget);
    expect(fs.readFileSync(fixture.prepareSkipBuildCapture, "utf8")).toBe("1");
    expect(fs.readFileSync(fixture.stageArgsCapture, "utf8")).toContain(
      "--package hmux-cli --package hmux-runtime",
    );
    expect(fs.readFileSync(appRuntime, "utf8")).toBe("active-app-runtime");
    expect(fs.readFileSync(appCli, "utf8")).toBe("active-app-cli");
  });

  test.skipIf(process.platform !== "darwin")(
    "reinstalling one dev build survives nondeterministic Mach-O object names",
    () => {
      const root = temporaryDirectory();
      const [first, second] = machODevRebuildFixture(root);
      const firstSourceBytes = fs.readFileSync(first);
      const secondSourceBytes = fs.readFileSync(second);
      expect(firstSourceBytes).not.toEqual(secondSourceBytes);

      const tools = path.join(root, "tools");
      const proof = path.join(root, "ghostty-proof");
      const installRoot = path.join(root, "install");
      const commands = path.join(root, "commands");
      fs.mkdirSync(proof, { recursive: true });
      fs.writeFileSync(
        path.join(proof, "hmux-ghostty-vt-proof.receipt"),
        "fixture receipt validated by the real Cargo build boundary\n",
      );
      executable(
        path.join(tools, "cargo"),
        `#!/bin/sh
artifact_directory="$CARGO_TARGET_DIR/$CARGO_BUILD_TARGET/debug"
mkdir -p "$artifact_directory"
cp "$HMUX_TEST_VARIANT" "$artifact_directory/hmux"
cp "$HMUX_TEST_VARIANT" "$artifact_directory/hmux-runtime"
chmod 755 "$artifact_directory/hmux" "$artifact_directory/hmux-runtime"
`,
      );

      const stageAndInstall = (variant, target) => {
        const artifacts = `${target}-artifacts`;
        fs.mkdirSync(artifacts, { recursive: true });
        execFileSync(
          "/bin/sh",
          [path.resolve("scripts/stage-hmux-runtime.sh"), "debug"],
          {
            cwd: root,
            env: {
              ...process.env,
              CARGO_BUILD_TARGET: "aarch64-apple-darwin",
              CARGO_TARGET_DIR: target,
              HMUX_BUILD_ID: "0.1.4+dev.stable-fixture",
              HMUX_GHOSTTY_VT_PROOF_PREFIX: proof,
              HMUX_STAGE_ARTIFACT_DIR: artifacts,
              HMUX_TEST_VARIANT: variant,
              DURE_NATIVE_BUILD_SLOT_ROOT: path.join(root, "build-slot"),
              PATH: `${tools}${path.delimiter}${process.env.PATH}`,
            },
            stdio: "pipe",
          },
        );
        execFileSync("/bin/sh", [path.resolve("scripts/install-hmux.sh")], {
          cwd: path.resolve("."),
          env: {
            ...process.env,
            CARGO_BUILD_TARGET: "aarch64-apple-darwin",
            HOME: root,
            HMUX_ARTIFACT_DIR: artifacts,
            HMUX_BUILD_ID: "0.1.4+dev.stable-fixture",
            HMUX_INSTALL_DIR: commands,
            HMUX_INSTALL_ROOT: installRoot,
            HMUX_PROFILE: "debug",
            HMUX_SKIP_BUILD: "1",
          },
          stdio: "pipe",
        });
      };

      stageAndInstall(first, path.join(root, "target-first"));
      expect(() =>
        stageAndInstall(second, path.join(root, "target-second")),
      ).not.toThrow();
      expect(fs.readFileSync(first)).toEqual(firstSourceBytes);
      expect(fs.readFileSync(second)).toEqual(secondSourceBytes);
    },
  );

  test.skipIf(process.platform !== "darwin")(
    "concurrent stages normalize private copies without mutating Cargo output",
    async () => {
      const root = temporaryDirectory();
      const [source] = machODevRebuildFixture(root);
      const tools = path.join(root, "tools");
      const proof = path.join(root, "ghostty-proof");
      const target = path.join(root, "target");
      const buildId = "0.1.4+dev.concurrent-fixture";
      const builtArtifacts = path.join(
        target,
        "agent-tools",
        buildId,
        "aarch64-apple-darwin/debug",
      );
      const firstPrivateArtifacts = path.join(root, "private-first");
      const secondPrivateArtifacts = path.join(root, "private-second");
      fs.mkdirSync(builtArtifacts, { recursive: true });
      fs.mkdirSync(firstPrivateArtifacts);
      fs.mkdirSync(secondPrivateArtifacts);
      fs.mkdirSync(proof, { recursive: true });
      fs.writeFileSync(
        path.join(proof, "hmux-ghostty-vt-proof.receipt"),
        "fixture receipt validated by the real Cargo build boundary\n",
      );
      fs.copyFileSync(source, path.join(builtArtifacts, "hmux"));
      fs.copyFileSync(source, path.join(builtArtifacts, "hmux-runtime"));
      executable(path.join(tools, "cargo"), "#!/bin/sh\nexit 0\n");
      const cliBefore = fs.readFileSync(path.join(builtArtifacts, "hmux"));
      const runtimeBefore = fs.readFileSync(
        path.join(builtArtifacts, "hmux-runtime"),
      );
      const stage = (artifacts) =>
        execFileAsync(
          "/bin/sh",
          [path.resolve("scripts/stage-hmux-runtime.sh"), "debug"],
          {
            cwd: root,
            env: {
              ...process.env,
              CARGO_BUILD_TARGET: "aarch64-apple-darwin",
              CARGO_TARGET_DIR: target,
              HMUX_BUILD_ID: buildId,
              DURE_NATIVE_BUILD_SLOT_ROOT: path.join(root, "build-slot"),
              HMUX_GHOSTTY_VT_PROOF_PREFIX: proof,
              HMUX_STAGE_ARTIFACT_DIR: artifacts,
              PATH: `${tools}${path.delimiter}${process.env.PATH}`,
            },
          },
        );

      await Promise.all([
        stage(firstPrivateArtifacts),
        stage(secondPrivateArtifacts),
      ]);

      expect(fs.readFileSync(path.join(builtArtifacts, "hmux"))).toEqual(
        cliBefore,
      );
      expect(
        fs.readFileSync(path.join(builtArtifacts, "hmux-runtime")),
      ).toEqual(runtimeBefore);
      for (const binary of ["hmux", "hmux-runtime"]) {
        const firstArtifact = fs.readFileSync(
          path.join(firstPrivateArtifacts, binary),
        );
        const secondArtifact = fs.readFileSync(
          path.join(secondPrivateArtifacts, binary),
        );
        expect(firstArtifact).toEqual(secondArtifact);
      }
    },
  );

  test("concurrent dev preparation cannot move stable current, even when one channel fails", async () => {
    const root = temporaryDirectory();
    const fixture = agentToolBuildFixture(root);
    const repositoryRoot = path.resolve(".");
    const stableRoot = path.join(root, ".local/share/hmux");
    fs.mkdirSync(path.join(stableRoot, "versions/stable-build"), {
      recursive: true,
    });
    executable(
      path.join(stableRoot, "versions/stable-build/bin/hmux"),
      "stable-build",
    );
    fs.symlinkSync("versions/stable-build", path.join(stableRoot, "current"));
    const stableCommand = path.join(root, ".local/bin/hmux");
    fs.mkdirSync(path.dirname(stableCommand), { recursive: true });
    fs.symlinkSync(
      path.join(stableRoot, "current/bin/hmux"),
      stableCommand,
    );

    const prepare = (channel, environment = {}) =>
      execFileAsync(
        "/bin/sh",
        [path.join(repositoryRoot, "scripts/prepare-agent-tools.sh")],
        {
          cwd: root,
          env: {
            ...fixture.environment,
            HEBBIAN_APP_CHANNEL: "dev-inherited-wrong-a1b2c3d4",
            HMUX_INSTALL_DIR: path.join(root, ".local/bin"),
            HMUX_INSTALL_ROOT: stableRoot,
            PREPARE_CHANNEL: channel,
            ...environment,
          },
        },
      );

    const [successful, failed] = await Promise.allSettled([
      prepare("dev-new-a1b2c3d4", {
        PREPARE_BUILD_ID: "0.1.4+dev.new",
      }),
      prepare("dev-old-a1b2c3d4", {
        PREPARE_BUILD_ID: "0.1.4+dev.old",
        PREPARE_FAIL_BEFORE_ACTIVATION: "1",
      }),
    ]);

    expect(successful.status, successful.reason?.stack).toBe("fulfilled");
    expect(failed.status).toBe("rejected");
    expect(fs.readlinkSync(path.join(stableRoot, "current"))).toBe(
      "versions/stable-build",
    );
    expect(fs.realpathSync(stableCommand)).toBe(
      fs.realpathSync(path.join(stableRoot, "versions/stable-build/bin/hmux")),
    );
    expect(
      fs.readlinkSync(
        path.join(
          stableRoot,
          "channels/dev-new-a1b2c3d4/current",
        ),
      ),
    ).toBe("versions/0.1.4+dev.new");
    expect(
      fs.existsSync(
        path.join(
          stableRoot,
          "channels/dev-old-a1b2c3d4/current",
        ),
      ),
    ).toBe(false);
  });
});

describe("live-reference-aware Hmux version pruning", () => {
  test("uses one exact root when HMUX_DISCOVERY_ROOT is explicit", () => {
    expect(
      defaultDiscoveryRoots(
        {
          HMUX_DISCOVERY_ROOT: "/fixture/exact",
          DURE_HOME: "/fixture/dure",
          HEBBIAN_HOME: "/fixture/legacy-portable",
          HOME: "/fixture/home",
          XDG_STATE_HOME: "/fixture/state",
        },
        "linux",
      ),
    ).toEqual([path.resolve("/fixture/exact")]);
    expect(() =>
      defaultDiscoveryRoots(
        { HMUX_DISCOVERY_ROOT: "", DURE_HOME: "/fixture/dure" },
        "linux",
      ),
    ).toThrow("HMUX_DISCOVERY_ROOT must not be empty");
  });

  test("scans the canonical Dure root before bounded legacy roots", () => {
    expect(
      defaultDiscoveryRoots(
        {
          DURE_HOME: "/fixture/dure",
          HEBBIAN_HOME: "/fixture/legacy-portable",
          HOME: "/fixture/home",
          XDG_STATE_HOME: "/fixture/state",
        },
        "linux",
      ),
    ).toEqual([
      path.resolve("/fixture/dure/state/hmux-hosts"),
      path.resolve("/fixture/legacy-portable/state/hebbian-agent/hmux-hosts"),
      path.resolve("/fixture/state/hebbian/hebbian-agent/hmux-hosts"),
    ]);
    expect(() => defaultDiscoveryRoots({}, "linux")).toThrow(
      "HMUX_DISCOVERY_ROOT, DURE_HOME, or HOME is required",
    );
  });

  test("prune CLI exposes bounded quotas without mutating its dry-run plan", () => {
    const root = temporaryDirectory();
    const installRoot = path.join(root, "install");
    installedVersion(installRoot, "current-build", 3_000);
    const previous = installedVersion(installRoot, "previous-build", 2_000);
    const stale = installedVersion(installRoot, "stale-build", 1_000);
    fs.symlinkSync("versions/current-build", path.join(installRoot, "current"));
    fs.symlinkSync("versions/previous-build", path.join(installRoot, "previous"));

    const output = execFileSync(
      process.execPath,
      [
        pruneHmuxVersionsScript,
        "--install-root",
        installRoot,
        "--discovery-root",
        path.join(root, "missing-discovery"),
        "--retain",
        "0",
        "--max-versions",
        "1",
        "--max-bytes",
        String(Number.MAX_SAFE_INTEGER),
      ],
      {
        encoding: "utf8",
        env: { ...process.env, HOME: root },
      },
    );
    const report = JSON.parse(output);

    expect(report.mode).toBe("dry_run");
    expect(report.discoveryRoots).toEqual([
      path.resolve(root, "missing-discovery"),
    ]);
    expect(report.previousBuildId).toBe("previous-build");
    expect(report.budgetUnmet).toBe(true);
    expect(report.removed).toEqual([]);
    expect(fs.existsSync(previous)).toBe(true);
    expect(fs.existsSync(stale)).toBe(true);

    const explicitOnlyReport = JSON.parse(
      execFileSync(
        process.execPath,
        [
          pruneHmuxVersionsScript,
          "--install-root",
          installRoot,
          "--discovery-root",
          path.join(root, "missing-discovery"),
        ],
        { encoding: "utf8", env: {} },
      ),
    );
    expect(explicitOnlyReport.discoveryRoots).toEqual([
      path.resolve(root, "missing-discovery"),
    ]);
  });

  test("protects the rollback target named by previous", () => {
    const root = temporaryDirectory();
    const installRoot = path.join(root, "install");
    installedVersion(installRoot, "current-build", 3_000);
    const previous = installedVersion(installRoot, "previous-build", 2_000);
    const stale = installedVersion(installRoot, "stale-build", 1_000);
    fs.symlinkSync("versions/current-build", path.join(installRoot, "current"));
    fs.symlinkSync("versions/previous-build", path.join(installRoot, "previous"));

    const plan = planVersionPrune({
      installRoot,
      discoveryRoots: [],
      retain: 0,
    });

    expect(plan.previousBuildId).toBe("previous-build");
    expect(plan.removals).toEqual([stale]);
    expect(plan.protectedVersions).toContainEqual(
      expect.objectContaining({
        buildId: "previous-build",
        reasons: ["previous"],
      }),
    );
    applyVersionPrune(plan);
    expect(fs.existsSync(previous)).toBe(true);
  });

  test("reports a bounded, reasoned plan for an 80-version store", () => {
    const root = temporaryDirectory();
    const installRoot = path.join(root, "install");
    for (let index = 0; index < 80; index += 1) {
      installedVersion(
        installRoot,
        `build-${String(index).padStart(2, "0")}`,
        index + 1,
      );
    }
    fs.symlinkSync("versions/build-79", path.join(installRoot, "current"));
    fs.symlinkSync("versions/build-78", path.join(installRoot, "previous"));

    const plan = planVersionPrune({
      installRoot,
      discoveryRoots: [],
      retain: 2,
      maxVersions: 32,
      maxTotalBytes: 512 * 1024 * 1024,
    });

    expect(plan.installedVersions).toBe(80);
    expect(plan.removalVersions).toBe(76);
    expect(plan.projectedVersions).toBe(4);
    expect(plan.projectedBytes).toBeLessThanOrEqual(plan.installedBytes);
    expect(plan.budgetUnmet).toBe(false);
    expect(plan.candidateSummary).toEqual({
      healthy: 2,
      stale: 0,
      orphan: 78,
      indeterminate: 0,
    });
    expect(plan.removalCandidates).toHaveLength(76);
    expect(
      plan.removalCandidates.every(
        (candidate) => candidate.reason === "unreferenced_version",
      ),
    ).toBe(true);
  });

  test("retains current and live builds and removes only stale versions", () => {
    const root = temporaryDirectory();
    const installRoot = path.join(root, "install");
    const discoveryRoot = path.join(root, "discovery");
    const current = installedVersion(installRoot, "current-build", 3_000);
    const live = installedVersion(installRoot, "live-build", 2_000);
    const stale = installedVersion(installRoot, "stale-build", 1_000);
    fs.symlinkSync("versions/current-build", path.join(installRoot, "current"));
    fs.mkdirSync(path.join(discoveryRoot, "workspace/session"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(discoveryRoot, "workspace/session/manifest.json"),
      JSON.stringify(readyManifest("live-build", process.pid)),
    );

    const plan = planVersionPrune({
      installRoot,
      discoveryRoots: [discoveryRoot],
      retain: 0,
    });

    expect(plan.removals).toEqual([stale]);
    expect(plan.retainedBuildIds).toEqual(["current-build", "live-build"]);
    applyVersionPrune(plan);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(current)).toBe(true);
    expect(fs.existsSync(live)).toBe(true);
  });

  test("retains a process-live build even when the control plane reports stale transport", () => {
    const root = temporaryDirectory();
    const installRoot = path.join(root, "install");
    const discoveryRoot = path.join(root, "discovery");
    installedVersion(installRoot, "current-build", 2_000);
    const staleTransportBuild = installedVersion(
      installRoot,
      "stale-transport-build",
      1_000,
    );
    fs.symlinkSync("versions/current-build", path.join(installRoot, "current"));
    fs.mkdirSync(discoveryRoot, { recursive: true });
    const manifest = readyManifest("stale-transport-build", process.pid);
    manifest.control_plane_health = "stale_transport";
    fs.writeFileSync(
      path.join(discoveryRoot, "manifest.json"),
      JSON.stringify(manifest),
    );

    const plan = planVersionPrune({
      installRoot,
      discoveryRoots: [discoveryRoot],
      retain: 0,
    });

    expect(plan.liveBuildIds).toEqual(["stale-transport-build"]);
    expect(plan.removals).not.toContain(staleTransportBuild);
  });

  test("retains a durable Ready build after its recorded Host process exits", () => {
    const root = temporaryDirectory();
    const installRoot = path.join(root, "install");
    const discoveryRoot = path.join(root, "discovery");
    installedVersion(installRoot, "current-build", 2_000);
    const rebootRecoveryBuild = installedVersion(
      installRoot,
      "reboot-recovery-build",
      1_000,
    );
    fs.symlinkSync("versions/current-build", path.join(installRoot, "current"));
    fs.mkdirSync(discoveryRoot, { recursive: true });
    fs.writeFileSync(
      path.join(discoveryRoot, "manifest.json"),
      JSON.stringify(readyManifest("reboot-recovery-build", 123)),
    );

    const plan = planVersionPrune({
      installRoot,
      discoveryRoots: [discoveryRoot],
      retain: 0,
      isProcessLive: () => false,
    });

    expect(plan.liveBuildIds).toEqual(["reboot-recovery-build"]);
    expect(plan.removals).not.toContain(rebootRecoveryBuild);
    expect(plan.protectedVersions).toContainEqual(
      expect.objectContaining({
        buildId: "reboot-recovery-build",
        reasons: ["durable_ready_receipt"],
      }),
    );
    expect(plan.candidateSummary).toEqual({
      healthy: 1,
      stale: 1,
      orphan: 0,
      indeterminate: 0,
    });
  });

  test("protects but does not call an unobservable process healthy", () => {
    const root = temporaryDirectory();
    const installRoot = path.join(root, "install");
    const discoveryRoot = path.join(root, "discovery");
    installedVersion(installRoot, "current-build", 2_000);
    const unknown = installedVersion(installRoot, "unknown-build", 1_000);
    fs.symlinkSync("versions/current-build", path.join(installRoot, "current"));
    fs.mkdirSync(discoveryRoot, { recursive: true });
    fs.writeFileSync(
      path.join(discoveryRoot, "manifest.json"),
      JSON.stringify(readyManifest("unknown-build", undefined)),
    );

    const plan = planVersionPrune({
      installRoot,
      discoveryRoots: [discoveryRoot],
      retain: 0,
    });

    expect(plan.removals).not.toContain(unknown);
    expect(plan.candidateSummary).toEqual({
      healthy: 1,
      stale: 0,
      orphan: 0,
      indeterminate: 1,
    });
    expect(plan.protectedVersions).toContainEqual(
      expect.objectContaining({
        buildId: "unknown-build",
        reasons: [
          "durable_ready_receipt",
          "process_liveness_indeterminate",
        ],
      }),
    );
  });

  test("fails closed when a live manifest cannot identify a safe build", () => {
    const root = temporaryDirectory();
    const installRoot = path.join(root, "install");
    const discoveryRoot = path.join(root, "discovery");
    installedVersion(installRoot, "current-build", 1_000);
    fs.symlinkSync("versions/current-build", path.join(installRoot, "current"));
    fs.mkdirSync(discoveryRoot, { recursive: true });
    fs.writeFileSync(
      path.join(discoveryRoot, "manifest.json"),
      JSON.stringify(readyManifest("../unsafe", 123)),
    );

    expect(() =>
      planVersionPrune({
        installRoot,
        discoveryRoots: [discoveryRoot],
        retain: 0,
        isProcessLive: () => true,
      }),
    ).toThrow(/unsafe build id/);
  });

  test("fails closed for missing or forward-version manifest lifecycle", () => {
    const root = temporaryDirectory();
    const installRoot = path.join(root, "install");
    const discoveryRoot = path.join(root, "discovery");
    installedVersion(installRoot, "current-build", 2_000);
    installedVersion(installRoot, "future-build", 1_000);
    fs.symlinkSync("versions/current-build", path.join(installRoot, "current"));
    fs.mkdirSync(discoveryRoot, { recursive: true });
    const manifestPath = path.join(discoveryRoot, "manifest.json");
    const manifest = readyManifest("future-build", 123);
    delete manifest.lifecycle;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    const plan = () =>
      planVersionPrune({
        installRoot,
        discoveryRoots: [discoveryRoot],
        retain: 0,
        isProcessLive: () => false,
      });

    expect(plan).toThrow(/manifest lifecycle/);
    manifest.lifecycle = "paused_v2";
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(plan).toThrow(/manifest lifecycle/);
  });

  test("rechecks live references immediately before deletion", () => {
    const root = temporaryDirectory();
    const installRoot = path.join(root, "install");
    const discoveryRoot = path.join(root, "discovery");
    installedVersion(installRoot, "current-build", 2_000);
    const candidate = installedVersion(installRoot, "newly-live", 1_000);
    fs.symlinkSync("versions/current-build", path.join(installRoot, "current"));

    const plan = planVersionPrune({
      installRoot,
      discoveryRoots: [discoveryRoot],
      retain: 0,
    });
    expect(plan.removals).toEqual([candidate]);

    fs.mkdirSync(discoveryRoot, { recursive: true });
    fs.writeFileSync(
      path.join(discoveryRoot, "manifest.json"),
      JSON.stringify(readyManifest("newly-live", process.pid)),
    );

    expect(() => applyVersionPrune(plan)).toThrow(/live Hmux version/);
    expect(fs.existsSync(candidate)).toBe(true);
  });

  test("rechecks durable Ready references immediately before deletion", () => {
    const root = temporaryDirectory();
    const installRoot = path.join(root, "install");
    const discoveryRoot = path.join(root, "discovery");
    installedVersion(installRoot, "current-build", 2_000);
    const candidate = installedVersion(installRoot, "reboot-recovery", 1_000);
    fs.symlinkSync("versions/current-build", path.join(installRoot, "current"));

    const plan = planVersionPrune({
      installRoot,
      discoveryRoots: [discoveryRoot],
      retain: 0,
      isProcessLive: () => false,
    });
    expect(plan.removals).toEqual([candidate]);

    fs.mkdirSync(discoveryRoot, { recursive: true });
    fs.writeFileSync(
      path.join(discoveryRoot, "manifest.json"),
      JSON.stringify(readyManifest("reboot-recovery", 123)),
    );

    expect(() => applyVersionPrune(plan, () => false)).toThrow(
      /live Hmux version/,
    );
    expect(fs.existsSync(candidate)).toBe(true);
  });

  test("rechecks a newly published previous target immediately before deletion", () => {
    const root = temporaryDirectory();
    const installRoot = path.join(root, "install");
    installedVersion(installRoot, "current-build", 2_000);
    const candidate = installedVersion(installRoot, "rollback-build", 1_000);
    fs.symlinkSync("versions/current-build", path.join(installRoot, "current"));

    const plan = planVersionPrune({
      installRoot,
      discoveryRoots: [],
      retain: 0,
    });
    expect(plan.removals).toEqual([candidate]);

    fs.symlinkSync("versions/rollback-build", path.join(installRoot, "previous"));

    expect(() => applyVersionPrune(plan)).toThrow(/live Hmux version/);
    expect(fs.existsSync(candidate)).toBe(true);
  });

  test("reports when protected state alone cannot satisfy the configured quota", () => {
    const root = temporaryDirectory();
    const installRoot = path.join(root, "install");
    installedVersion(installRoot, "current-build", 2_000);
    installedVersion(installRoot, "previous-build", 1_000);
    fs.symlinkSync("versions/current-build", path.join(installRoot, "current"));
    fs.symlinkSync("versions/previous-build", path.join(installRoot, "previous"));

    const plan = planVersionPrune({
      installRoot,
      discoveryRoots: [],
      retain: 0,
      maxVersions: 1,
      maxTotalBytes: Number.MAX_SAFE_INTEGER,
    });

    expect(plan.removals).toEqual([]);
    expect(plan.projectedVersions).toBe(2);
    expect(plan.budgetUnmet).toBe(true);
  });

  test("quota caps best-effort retention without removing mandatory protection", () => {
    const root = temporaryDirectory();
    const installRoot = path.join(root, "install");
    installedVersion(installRoot, "current-build", 4_000);
    installedVersion(installRoot, "newest-orphan", 3_000);
    installedVersion(installRoot, "middle-orphan", 2_000);
    installedVersion(installRoot, "oldest-orphan", 1_000);
    fs.symlinkSync("versions/current-build", path.join(installRoot, "current"));

    const plan = planVersionPrune({
      installRoot,
      discoveryRoots: [],
      retain: 3,
      maxVersions: 2,
      maxTotalBytes: Number.MAX_SAFE_INTEGER,
    });

    expect(plan.retainedBuildIds).toEqual(["current-build", "newest-orphan"]);
    expect(plan.projectedVersions).toBe(2);
    expect(plan.budgetUnmet).toBe(false);
  });

  test("refuses an unknown lifecycle discovered immediately before deletion", () => {
    const root = temporaryDirectory();
    const installRoot = path.join(root, "install");
    const discoveryRoot = path.join(root, "discovery");
    installedVersion(installRoot, "current-build", 2_000);
    const candidate = installedVersion(installRoot, "future-build", 1_000);
    fs.symlinkSync("versions/current-build", path.join(installRoot, "current"));

    const plan = planVersionPrune({
      installRoot,
      discoveryRoots: [discoveryRoot],
      retain: 0,
      isProcessLive: () => false,
    });
    expect(plan.removals).toEqual([candidate]);

    fs.mkdirSync(discoveryRoot, { recursive: true });
    const manifest = readyManifest("future-build", 123);
    manifest.lifecycle = "paused_v2";
    fs.writeFileSync(
      path.join(discoveryRoot, "manifest.json"),
      JSON.stringify(manifest),
    );

    expect(() => applyVersionPrune(plan, () => false)).toThrow(
      /manifest lifecycle/,
    );
    expect(fs.existsSync(candidate)).toBe(true);
  });

  test("does nothing when no versions are installed", () => {
    const root = temporaryDirectory();
    const plan = planVersionPrune({
      installRoot: path.join(root, "install"),
      discoveryRoots: [],
      retain: 0,
    });

    expect(applyVersionPrune(plan)).toEqual([]);
  });

  test("refuses to race another install or prune mutation", () => {
    const root = temporaryDirectory();
    const installRoot = path.join(root, "install");
    installedVersion(installRoot, "current-build", 2_000);
    const candidate = installedVersion(installRoot, "stale-build", 1_000);
    fs.symlinkSync("versions/current-build", path.join(installRoot, "current"));
    const plan = planVersionPrune({
      installRoot,
      discoveryRoots: [],
      retain: 0,
    });
    fs.mkdirSync(path.join(installRoot, ".mutation-lock"));

    expect(() => applyVersionPrune(plan)).toThrow(/mutation-lock/);
    expect(fs.existsSync(candidate)).toBe(true);
  });
});
