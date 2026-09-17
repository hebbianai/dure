import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePlainInteractiveSsh } from "../cli/lib/ssh-command.mjs";

describe("plain interactive ssh classifier", () => {
  it("accepts an exact interactive login with structural user and port options", () => {
    expect(parsePlainInteractiveSsh(["rts@211.181.122.124"])).toEqual({
      kind: "handoff",
      destination: { host: "211.181.122.124", user: "rts" },
    });
    expect(parsePlainInteractiveSsh(["-p", "2222", "-luser", "server"])).toEqual({
      kind: "handoff",
      destination: { host: "server", user: "user", port: 2222 },
    });
    expect(
      parsePlainInteractiveSsh([
        "s-gate0@211.181.122.88",
        "-p",
        "6826",
      ]),
    ).toEqual({
      kind: "handoff",
      destination: {
        host: "211.181.122.88",
        user: "s-gate0",
        port: 6826,
      },
    });
  });

  it.each([
    ["-L", "8080:localhost:80", "server"],
    ["-R", "8080:localhost:80", "server"],
    ["-D", "1080", "server"],
    ["-W", "target:22", "server"],
    ["-N", "server"],
    ["-T", "server"],
    ["-s", "server", "sftp"],
    ["server", "uname", "-a"],
    ["-F", "/tmp/config", "server"],
    ["-J", "jump", "server"],
  ])("falls back without interpreting forwarding or command argv: %j", (...argv) => {
    expect(parsePlainInteractiveSsh(argv).kind).toBe("fallback");
  });

  it("rejects missing, malformed, and multi-destination forms", () => {
    expect(parsePlainInteractiveSsh([]).kind).toBe("fallback");
    expect(parsePlainInteractiveSsh(["-p", "70000", "server"]).kind).toBe(
      "fallback",
    );
    expect(parsePlainInteractiveSsh(["one", "two"]).kind).toBe("fallback");
  });
});

describe("agent tool channel preparation", () => {
  it("installs the Dure SSH shim into the exact development channel", () => {
    const root = mkdtempSync(join(tmpdir(), "dure-ssh-channel-"));
    try {
      const tools = join(root, "tools");
      const scripts = join(root, "scripts");
      const installRootCapture = join(root, "dure-install-root");
      const commandDirectoryCapture = join(root, "dure-command-directory");
      const sourceRevisionCapture = join(root, "dure-source-revision");
      const stageProfileCapture = join(root, "hmux-stage-profile");
      mkdirSync(tools, { recursive: true });
      mkdirSync(scripts, { recursive: true });
      copyFileSync(
        resolve("scripts/prepare-agent-tools.sh"),
        join(scripts, "prepare-agent-tools.sh"),
      );
      copyFileSync(
        resolve("scripts/prepare-hmux-dev-tools.sh"),
        join(scripts, "prepare-hmux-dev-tools.sh"),
      );
      writeFileSync(
        join(scripts, "stage-hmux-runtime.sh"),
        '#!/bin/sh\nprintf \'%s\' "$1" >"$HMUX_STAGE_PROFILE_CAPTURE"\n',
      );
      writeFileSync(join(scripts, "install-hmux.sh"), "#!/bin/sh\nexit 0\n");
      const node = join(tools, "node");
      writeFileSync(
        node,
        `#!/bin/sh
case "$1" in
  scripts/hmux-dev-build-id.mjs)
    printf '%s\\n' '0.1.4+dev.fixture'
    ;;
  scripts/resolve-dev-app-channel.mjs)
    printf '%s\\n' 'dev-ssh-fixture-a1b2c3d4'
    ;;
  */dev-agent-tools-current.mjs)
    [ "\${4:-}" = "--verify" ] && [ -f "$DURE_INSTALL_ROOT_CAPTURE" ]
    exit $?
    ;;
  scripts/install-dure-cli.mjs)
    printf '%s' "$DURE_CLI_INSTALL_ROOT" >"$DURE_INSTALL_ROOT_CAPTURE"
    printf '%s' "$DURE_CLI_INSTALL_DIR" >"$DURE_COMMAND_DIRECTORY_CAPTURE"
    printf '%s' "$DURE_CLI_SOURCE_REVISION" >"$DURE_SOURCE_REVISION_CAPTURE"
    ;;
  *)
    exit 64
    ;;
esac
`,
      );
      chmodSync(node, 0o755);
      execFileSync("git", ["init", "--quiet"], { cwd: root });
      execFileSync("git", ["add", "."], { cwd: root });
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
          "fixture source",
        ],
        { cwd: root },
      );

      const prepareEnvironment = {
        DURE_COMMAND_DIRECTORY_CAPTURE: commandDirectoryCapture,
        DURE_INSTALL_ROOT_CAPTURE: installRootCapture,
        DURE_SOURCE_REVISION_CAPTURE: sourceRevisionCapture,
        HMUX_STAGE_PROFILE_CAPTURE: stageProfileCapture,
        HOME: root,
        PATH: `${tools}:/usr/bin:/bin`,
      };
      const prepare = () =>
        execFileSync("/bin/sh", [join(scripts, "prepare-agent-tools.sh")], {
          cwd: root,
          env: prepareEnvironment,
          stdio: "pipe",
        });
      prepare();

      const expectedInstallRoot = join(
        root,
        ".local/share/hebbian-ide-cli/channels/dev-ssh-fixture-a1b2c3d4",
      );
      expect(readFileSync(installRootCapture, "utf8")).toBe(expectedInstallRoot);
      expect(readFileSync(commandDirectoryCapture, "utf8")).toBe(
        join(expectedInstallRoot, "bin"),
      );
      expect(readFileSync(stageProfileCapture, "utf8")).toBe("debug");
      expect(readFileSync(sourceRevisionCapture, "utf8")).toBe(
        execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: root,
          encoding: "utf8",
        }).trim(),
      );
      prepare();
      expect(readFileSync(sourceRevisionCapture, "utf8")).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
