import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { artifactDigest } from "../../cli/lib/dure-cli-channel-launcher.mjs";
import { ensureHeadroom } from "../lib/build-storage-admission.mjs";
import { corepackInstallInvocation } from "../lib/corepack-install.mjs";
import { scriptTestEnvironment } from "../lib/script-test-environment.mjs";

assert.equal(process.platform, "win32", "This proof requires native Windows.");
const repository = fileURLToPath(new URL("../..", import.meta.url));
const admission = ensureHeadroom({
  cwd: repository,
  label: "Windows Claude SDK install proof",
  requestedBytes: 512 * 1024 * 1024,
  ...(process.env.RUNNER_ENVIRONMENT === "github-hosted"
    ? { floorBytes: 0, goalBytes: 0 }
    : {}),
});
assert.ok(admission.ok, admission.message);
// Keep dependency growth on the admitted repository volume. A space in the
// fixture path also exercises cwd and module loading without shell quoting.
const root = fs.mkdtempSync(path.join(repository, ".qa-claude-install-"));
const source = path.join(root, "source driver");
const version = path.join(root, "versions", "native-proof");
const staged = path.join(version, "bin", "provider-drivers", "claude");
const profile = path.join(root, "profile");
fs.mkdirSync(source);
fs.mkdirSync(profile);
const environment = scriptTestEnvironment({
  USERPROFILE: profile,
  HOME: profile,
  APPDATA: path.join(profile, "AppData", "Roaming"),
  LOCALAPPDATA: path.join(profile, "AppData", "Local"),
  COREPACK_HOME: path.join(root, "corepack"),
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  NODE_DISABLE_COMPILE_CACHE: "1",
  CI: "true",
});
const driver = path.join(
  repository, "crates", "dure-app", "control-plane", "provider-drivers", "claude",
);
let completed = false;
try {
  for (const name of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "sdk-runtime.mjs"]) {
    fs.copyFileSync(path.join(driver, name), path.join(source, name));
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8"));
  assert.equal(process.versions.node, manifest.engines.node);
  const invocation = corepackInstallInvocation({ packageManager: manifest.packageManager });
  const options = { cwd: source, env: environment, windowsHide: true };
  const shims = execFileSync("where.exe", ["corepack.cmd"], {
    ...options, encoding: "utf8",
  }).trim().split(/\r?\n/u);
  assert.ok(shims[0] && fs.statSync(shims[0]).isFile());

  // Same real shim, cwd and pinned install arguments as the supported path.
  // Direct execFile cannot enter a .cmd shim on Windows; it must fail before
  // dependencies exist. A missing executable is not the expected negative.
  const legacy = spawnSync(shims[0], invocation.arguments.slice(4), options);
  assert.equal(legacy.error?.code, "EINVAL");
  assert.equal(fs.existsSync(path.join(source, "node_modules")), false);
  console.log(JSON.stringify({ observation: "legacy-direct-shim", code: legacy.error.code }));

  execFileSync(invocation.file, invocation.arguments, { ...options, stdio: "inherit" });
  const corepackVersion = execFileSync(invocation.file, ["/d", "/s", "/c", "corepack", "--version"], {
    ...options, encoding: "utf8",
  }).trim();

  // Preserve links exactly as the installer does. Dereferencing here would
  // conceal an external junction left by an incorrect dependency layout.
  fs.cpSync(source, staged, { recursive: true, verbatimSymlinks: true });
  fs.renameSync(source, path.join(root, "retired source"));
  assert.equal(fs.existsSync(source), false);
  let entries = 0;
  const pending = [path.join(staged, "node_modules")];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      entries += 1;
      assert.equal(entry.isSymbolicLink(), false, "Sealed dependencies contain a link or junction");
      if (entry.isDirectory()) pending.push(path.join(directory, entry.name));
    }
  }
  const before = artifactDigest(version);
  // A fresh process prevents module caching from hiding a source dependency.
  const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    import { createRequire } from 'node:module';
    import { pathToFileURL } from 'node:url';
    const root = fs.realpathSync(process.argv[1]);
    const require = createRequire(path.join(root, 'package.json'));
    const entry = fs.realpathSync(require.resolve('@anthropic-ai/claude-agent-sdk'));
    const relative = path.relative(root, entry);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    const { loadPinnedClaudeSdk } = await import(pathToFileURL(path.join(root, 'sdk-runtime.mjs')));
    const metadata = await loadPinnedClaudeSdk();
    console.log(JSON.stringify({ sdkVersion: metadata.sdkVersion, sdkImported: metadata.sdkImported,
      nativePackagePresent: metadata.nativePackagePresent, sdkWithinVersion: true }));
  `, staged], { cwd: root, env: environment, encoding: "utf8", windowsHide: true }));
  assert.equal(result.sdkVersion, manifest.dependencies["@anthropic-ai/claude-agent-sdk"]);
  assert.equal(result.sdkImported, true);
  assert.equal(result.nativePackagePresent, false);
  assert.equal(artifactDigest(version), before);
  completed = true;
  console.log(JSON.stringify({
    observation: "native-install-and-relocate",
    platform: process.platform,
    node: process.version,
    corepackVersion,
    packageManager: manifest.packageManager,
    entries,
    symbolicLinks: 0,
    sourceMoved: true,
    payloadUnchanged: true,
    ...result,
  }));
} finally {
  if (completed) fs.rmSync(root, { recursive: true });
  else console.error(`Native install proof failed; disposable fixture retained at ${root}`);
  admission.reservation?.release();
}
