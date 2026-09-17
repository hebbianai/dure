import {
  chmodSync,
  closeSync,
  copyFileSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readlinkSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { withoutLocalGitOverrides } from "../lib/git-environment.mjs";
import { assertIsolatedCleanupBoundary } from "./lib/isolated-hmux-session-cleanup.mjs";

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const stateRoot = realpathSync(required("DURE_QA_STATE_ROOT"));
const home = realpathSync(required("HOME"));
if (home !== realpathSync(path.join(stateRoot, "home"))) {
  throw new Error("conversion setup HOME is outside the isolated QA root");
}
assertIsolatedCleanupBoundary(stateRoot, required("HMUX_DISCOVERY_ROOT"));

const sourceCodexHome = required("HEBBIAN_QA_REAL_CODEX_HOME");
const sourceAuth = path.join(sourceCodexHome, "auth.json");
const project = path.join(stateRoot, "project");
if (!lstatSync(sourceAuth).isFile()) {
  throw new Error("Codex auth.json is required for the real conversion smoke");
}

mkdirSync(project, { mode: 0o700 });
const gitOptions = { cwd: project, env: withoutLocalGitOverrides(), stdio: "pipe" };
execFileSync("git", ["init", "-q", "-b", "main"], gitOptions);
execFileSync("git", [
  "-c", "user.email=qa@qa", "-c", "user.name=qa", "-c", "commit.gpgsign=false",
  "commit", "-q", "--allow-empty", "-m", "base",
], gitOptions);

const sharedDirectories = [
  "attachments",
  "memories",
  "plugins",
  "rules",
  "sessions",
  "shell_snapshots",
  "skills",
  "vendor_imports",
];
const appendFiles = ["history.jsonl", "session_index.jsonl"];
const canonical = path.join(home, ".codex");
const accountRoot = path.join(home, ".dure", "accounts");
const profile = path.join(accountRoot, "codex-selected");
for (const directory of [canonical, accountRoot, profile]) {
  mkdirSync(directory, { mode: 0o700, recursive: true });
  chmodSync(directory, 0o700);
}
const canonicalRoot = realpathSync(canonical);

for (const name of sharedDirectories) {
  const source = path.join(canonicalRoot, name);
  mkdirSync(source, { mode: 0o700 });
  chmodSync(source, 0o700);
  const destination = path.join(profile, name);
  symlinkSync(source, destination);
  const metadata = lstatSync(destination);
  if (!metadata.isSymbolicLink() || readlinkSync(destination) !== source) {
    throw new Error(`invalid conversion shared-directory fixture: ${name}`);
  }
}

for (const name of appendFiles) {
  const source = path.join(canonicalRoot, name);
  closeSync(openSync(source, "wx", 0o600));
  chmodSync(source, 0o600);
  const destination = path.join(profile, name);
  linkSync(source, destination);
  const sourceMetadata = statSync(source);
  const destinationMetadata = statSync(destination);
  if (
    sourceMetadata.dev !== destinationMetadata.dev ||
    sourceMetadata.ino !== destinationMetadata.ino
  ) {
    throw new Error(`invalid conversion append-file fixture: ${name}`);
  }
}

for (const destination of [
  path.join(canonicalRoot, "auth.json"),
  path.join(profile, "auth.json"),
]) {
  copyFileSync(sourceAuth, destination);
  chmodSync(destination, 0o600);
  const metadata = statSync(destination);
  if (
    !metadata.isFile() ||
    metadata.nlink !== 1 ||
    (metadata.mode & 0o777) !== 0o600
  ) {
    throw new Error("conversion credential fixture is not private");
  }
}

// This isolated repository records the same explicit trust choice a new user
// would make. The app validates/copies it but must not invent canonical state.
writeFileSync(
  path.join(canonicalRoot, "config.toml"),
  `[projects.${JSON.stringify(project)}]\ntrust_level = "trusted"\n`,
  { encoding: "utf8", flag: "wx", mode: 0o600 },
);

const receipt = path.join(stateRoot, "conversion-home-setup.json");
writeFileSync(
  path.join(stateRoot, "qa.autorun"),
  `hmuxconversion-project=${project}\nhmuxcredential-profile=selected\n`,
  { encoding: "utf8", flag: "wx", mode: 0o600 },
);
writeFileSync(
  receipt,
  `${JSON.stringify({
    appendFiles,
    ok: true,
    profile: "codex-selected",
    project,
    schema: 1,
    sharedDirectories,
  })}\n`,
  { encoding: "utf8", flag: "wx", mode: 0o600 },
);
chmodSync(receipt, 0o600);
