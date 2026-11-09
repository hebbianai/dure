import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

const SYSTEM_DIRECTORY_LINE = 'system_applications_dir="/Applications"';
const DMG_BYTES = "published disk image";
const version = "9.8.7";
const dmgName = `Dure_${version}_aarch64.dmg`;
const digestOf = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.chmodSync(path.join(root, "system"), 0o755);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const tools = {
  curl: `#!/bin/sh
printf 'curl %s\\n' "$*" >> "$CALLS"
out=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    --output) out=$2; shift 2 ;;
    --header|--proto|--proto-redir|--retry) shift 2 ;;
    https://*) url=$1; shift ;;
    *) shift ;;
  esac
done
case "$url" in
  */beta/latest.json) source=$SERVED/feed.json ;;
  */releases/tags/v*) source=$SERVED/release.json ;;
  */releases/download/v*) source=$SERVED/dmg ;;
  *) exit 22 ;;
esac
[ -f "$source" ] || exit 22
cp "$source" "$out"
`,
  hdiutil: `#!/bin/sh
printf 'hdiutil %s\\n' "$*" >> "$CALLS"
if [ "$1" = attach ]; then
  while [ $# -gt 0 ]; do
    if [ "$1" = -mountpoint ]; then mount=$2; fi
    shift
  done
  cp -R "$SERVED/volume/." "$mount/"
fi
`,
  ditto: `#!/bin/sh\ncp -R "$1" "$2"\n`,
  codesign: `#!/bin/sh\nprintf 'codesign %s\\n' "$*" >> "$CALLS"\nexit "\${FAKE_CODESIGN_STATUS:-0}"\n`,
  spctl: `#!/bin/sh\nprintf 'spctl %s\\n' "$*" >> "$CALLS"\nexit "\${FAKE_SPCTL_STATUS:-0}"\n`,
  ps: `#!/bin/sh\nprintf '%s\\n' "\${FAKE_PROCESSES:-}"\n`,
  id: `#!/bin/sh\nprintf '%s\\n' "\${FAKE_UID:-501}"\n`,
  sysctl: `#!/bin/sh\nprintf '%s\\n' "\${FAKE_ARM64:-1}"\n`,
  uname: `#!/bin/sh
case "$1" in
  -s) printf '%s\\n' "\${FAKE_OS:-Darwin}" ;;
  -m) printf '%s\\n' "\${FAKE_ARCH:-arm64}" ;;
esac
`,
  shasum: `#!/usr/bin/env node
const { createHash } = require("node:crypto");
const file = process.argv[process.argv.length - 1];
const hash = createHash("sha256").update(require("node:fs").readFileSync(file)).digest("hex");
console.log(hash + "  " + file);
`,
  plutil: `#!/usr/bin/env node
const [, , flag, keyPath, format, , , file] = process.argv;
if (flag !== "-extract" || format !== "raw") process.exit(64);
let value = JSON.parse(require("node:fs").readFileSync(file, "utf8"));
for (const key of keyPath.split(".")) value = value?.[key];
if (value === undefined || value === null) process.exit(1);
process.stdout.write(String(value));
`,
};

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-install-macos-"));
  roots.push(root);
  const paths = {
    root,
    home: path.join(root, "home"),
    system: path.join(root, "system"),
    served: path.join(root, "served"),
    calls: path.join(root, "calls.log"),
    tools: path.join(root, "tools"),
    temporary: path.join(root, "tmp"),
  };
  for (const directory of [paths.home, paths.system, paths.served, paths.tools, paths.temporary]) {
    fs.mkdirSync(directory);
  }
  for (const [name, body] of Object.entries(tools)) {
    fs.writeFileSync(path.join(paths.tools, name), body, { mode: 0o755 });
  }
  const app = path.join(paths.served, "volume", "Dure.app", "Contents");
  const bin = path.join(app, "Resources", "resources", "dure-cli", "current", "bin");
  fs.mkdirSync(path.join(bin, "lib"), { recursive: true });
  fs.writeFileSync(path.join(app, "marker"), "new");
  fs.writeFileSync(path.join(bin, "lib", "dure-cli-bootstrap.mjs"), "");
  fs.writeFileSync(
    path.join(bin, "node"),
    `#!/bin/sh
printf 'bootstrap %s\\n' "$*" >> "$CALLS"
read -r unexpected && printf 'stdin %s\\n' "$unexpected" >> "$CALLS"
exit "\${FAKE_BOOTSTRAP_STATUS:-0}"
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, "dure"),
    `#!/bin/sh
printf 'dure %s\\n' "$*" >> "$CALLS"
exit "\${FAKE_COMMAND_INSTALL_STATUS:-0}"
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(paths.served, "feed.json"), JSON.stringify({ version }));
  fs.writeFileSync(path.join(paths.served, "dmg"), DMG_BYTES);
  writeRelease(paths, [{ name: dmgName, digest: digestOf(DMG_BYTES), label: null }]);
  return paths;
}

function writeRelease(paths, assets) {
  fs.writeFileSync(
    path.join(paths.served, "release.json"),
    JSON.stringify({
      assets: [{ name: "Dure.app.tar.gz", digest: digestOf("archive"), label: null }, ...assets],
    }),
  );
}

function runInstaller(paths, env = {}) {
  const source = fs.readFileSync("scripts/install-macos.sh", "utf8");
  // A rename must fail here rather than let a test reach the real folder.
  expect(source).toContain(SYSTEM_DIRECTORY_LINE);
  const script = source.replace(SYSTEM_DIRECTORY_LINE, `system_applications_dir="${paths.system}"`);
  const result = spawnSync("sh", [], {
    input: script,
    encoding: "utf8",
    env: {
      HOME: paths.home,
      PATH: [paths.tools, path.dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
      TMPDIR: paths.temporary,
      CALLS: paths.calls,
      SERVED: paths.served,
      ...env,
    },
  });
  return {
    ...result,
    calls: fs.existsSync(paths.calls) ? fs.readFileSync(paths.calls, "utf8") : "",
  };
}

function writeExistingApp(directory, marker) {
  const contents = path.join(directory, "Dure.app", "Contents");
  fs.mkdirSync(contents, { recursive: true });
  fs.writeFileSync(path.join(contents, "marker"), marker);
}

const installedMarker = (directory) =>
  fs.readFileSync(path.join(directory, "Dure.app", "Contents", "marker"), "utf8");
const isInstalled = (directory) => fs.existsSync(path.join(directory, "Dure.app"));
const leftovers = (paths, directory) => [
  ...fs.readdirSync(directory).filter((name) => name !== "Dure.app"),
  ...fs.readdirSync(paths.temporary),
];

test("installs a verified release into the system folder and adds the command", () => {
  const paths = makeFixture();
  const result = runInstaller(paths);

  expect(result.status, result.stderr).toBe(0);
  expect(installedMarker(paths.system)).toBe("new");
  expect(result.calls).toContain(`/releases/download/v${version}/${dmgName}`);
  expect(result.calls).toMatch(/^codesign --verify --deep --strict -R=.*identifier "io\.hebbian\.ade".*8L5WFHS4F9/m);
  expect(result.calls).toMatch(/^spctl --assess --type execute /m);
  expect(result.calls).toContain(`dure-cli-bootstrap.mjs ${paths.home} stable`);
  expect(result.calls.indexOf("bootstrap ")).toBeLessThan(result.calls.indexOf("dure install --global"));
  expect(result.calls.indexOf("dure install --global")).toBeGreaterThan(-1);
  expect(result.calls).toMatch(/^hdiutil attach .*-nobrowse -readonly/m);
  expect(result.calls).toMatch(/^hdiutil detach /m);
  expect(result.calls).not.toContain("stdin ");
  expect(result.stdout).toContain(`Dure ${version} is installed at ${paths.system}/Dure.app.`);
  expect(leftovers(paths, paths.system)).toEqual([]);
});

test("installs into the home Applications folder without write access to the system folder", () => {
  const paths = makeFixture();
  fs.chmodSync(paths.system, 0o555);
  const result = runInstaller(paths);

  expect(result.status, result.stderr).toBe(0);
  expect(isInstalled(paths.system)).toBe(false);
  expect(installedMarker(path.join(paths.home, "Applications"))).toBe("new");
});

test("honors an explicit destination folder", () => {
  const paths = makeFixture();
  const destination = path.join(paths.root, "custom", "apps");
  const result = runInstaller(paths, { DURE_APP_INSTALL_DIR: destination });

  expect(result.status, result.stderr).toBe(0);
  expect(installedMarker(destination)).toBe("new");
  expect(isInstalled(paths.system)).toBe(false);
});

test("replaces an existing app that is not running", () => {
  const paths = makeFixture();
  writeExistingApp(paths.system, "old");
  const result = runInstaller(paths);

  expect(result.status, result.stderr).toBe(0);
  expect(installedMarker(paths.system)).toBe("new");
  expect(leftovers(paths, paths.system)).toEqual([]);
});

test("refuses to replace a running app and only counts the app process", () => {
  const paths = makeFixture();
  writeExistingApp(paths.system, "old");
  const app = `${paths.system}/Dure.app/Contents/MacOS/dure`;
  const running = runInstaller(paths, { FAKE_PROCESSES: app });

  expect(running.status).toBe(1);
  expect(running.stderr).toContain("Quit Dure");
  expect(running.calls).not.toContain("curl");
  expect(installedMarker(paths.system)).toBe("old");

  const agentRuntimeOnly = runInstaller(paths, {
    FAKE_PROCESSES: `${paths.system}/Dure.app/Contents/Resources/resources/dure-cli/current/bin/dure-control-plane`,
  });
  expect(agentRuntimeOnly.status, agentRuntimeOnly.stderr).toBe(0);
  expect(installedMarker(paths.system)).toBe("new");
});

test.each([
  ["a different digest", [{ name: dmgName, digest: digestOf("tampered") }], "does not match"],
  ["no digest", [{ name: dmgName, digest: null }], "no SHA-256 digest"],
  ["no matching asset", [{ name: "Dure_other.dmg", digest: digestOf(DMG_BYTES) }], "no SHA-256 digest"],
  ["a malformed digest", [{ name: dmgName, digest: `sha256:${"g".repeat(64)}` }], "invalid digest"],
])("never opens a download with %s", (_label, assets, message) => {
  const paths = makeFixture();
  writeExistingApp(paths.system, "old");
  writeRelease(paths, assets);
  const result = runInstaller(paths);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain(message);
  expect(result.calls).not.toContain("hdiutil");
  expect(installedMarker(paths.system)).toBe("old");
  expect(leftovers(paths, paths.system)).toEqual([]);
});

test("refuses when the digest cannot be read", () => {
  const paths = makeFixture();
  fs.rmSync(path.join(paths.served, "release.json"));
  const result = runInstaller(paths);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("could not read the published digest");
  expect(result.calls).not.toContain("releases/download");
});

test("rejects a version the feed should never contain before building any URL", () => {
  const paths = makeFixture();
  fs.writeFileSync(path.join(paths.served, "feed.json"), JSON.stringify({ version: "1.0/../x" }));
  const result = runInstaller(paths);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("unexpected version");
  expect(result.calls).not.toContain("releases/tags");
});

test.each([
  ["signature", { FAKE_CODESIGN_STATUS: "1" }, "not signed by Dure"],
  ["notarization", { FAKE_SPCTL_STATUS: "3" }, "notarized"],
])("keeps the existing app and detaches when the %s check fails", (_label, env, message) => {
  const paths = makeFixture();
  writeExistingApp(paths.system, "old");
  const result = runInstaller(paths, env);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain(message);
  expect(result.calls).toMatch(/^hdiutil detach /m);
  expect(result.calls).not.toContain("bootstrap");
  expect(installedMarker(paths.system)).toBe("old");
  expect(leftovers(paths, paths.system)).toEqual([]);
});

test.each([
  ["the bootstrap", { FAKE_BOOTSTRAP_STATUS: "1" }],
  ["the command install", { FAKE_COMMAND_INSTALL_STATUS: "2" }],
])("reports a failure in %s without removing the installed app", (_label, env) => {
  const paths = makeFixture();
  const result = runInstaller(paths, env);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("the dure command could not be added");
  expect(installedMarker(paths.system)).toBe("new");
});

test("does not create the command after the bootstrap refuses", () => {
  const paths = makeFixture();
  const result = runInstaller(paths, { FAKE_BOOTSTRAP_STATUS: "1" });

  expect(result.calls).not.toContain("dure install");
});

test("shows the PATH line only when the command directory is missing from PATH", () => {
  const missing = makeFixture();
  const hint = runInstaller(missing);
  expect(hint.stdout).toContain('export PATH="$HOME/.local/bin:$PATH"');

  const present = makeFixture();
  const ready = runInstaller(present, {
    PATH: [
      present.tools,
      path.dirname(process.execPath),
      "/usr/bin",
      "/bin",
      `${present.home}/.local/bin`,
    ].join(":"),
  });
  expect(ready.status, ready.stderr).toBe(0);
  expect(ready.stdout).toContain("The dure command is ready.");
  expect(ready.stdout).not.toContain("export PATH");
});

test.each([
  ["another operating system", { FAKE_OS: "Linux" }, "macOS only"],
  ["an Intel Mac", { FAKE_ARCH: "x86_64", FAKE_ARM64: "0" }, "requires Apple silicon"],
  ["sudo", { FAKE_UID: "0" }, "without sudo"],
])("refuses %s before downloading", (_label, env, message) => {
  const paths = makeFixture();
  const result = runInstaller(paths, env);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain(message);
  expect(result.calls).toBe("");
});

test("accepts an Apple silicon Mac whose shell runs under Rosetta", () => {
  const paths = makeFixture();
  const result = runInstaller(paths, { FAKE_ARCH: "x86_64", FAKE_ARM64: "1" });

  expect(result.status, result.stderr).toBe(0);
  expect(installedMarker(paths.system)).toBe("new");
});
