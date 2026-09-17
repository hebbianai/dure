import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { workspacePerformanceProviderNames } from "./lib/workspace-performance-providers.mjs";

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const stateRoot = realpathSync(required("DURE_QA_STATE_ROOT"));
const home = realpathSync(required("HOME"));
if (home !== realpathSync(path.join(stateRoot, "home"))) {
  throw new Error("workspace performance HOME escaped its isolated root");
}

const sourceRoot = realpathSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-provider"),
);
const destinationRoot = path.join(home, ".local", "bin");
mkdirSync(destinationRoot, { mode: 0o700, recursive: true });
chmodSync(destinationRoot, 0o700);

const installed = [
  ...workspacePerformanceProviderNames,
  "dure-qa-fake-provider-common.sh",
];
for (const name of installed) {
  const source = path.join(sourceRoot, name);
  const metadata = lstatSync(source);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`fake provider source must be a regular file: ${name}`);
  }
  const destination = path.join(destinationRoot, name);
  copyFileSync(source, destination, 0);
  chmodSync(destination, name === "dure-qa-fake-provider-common.sh" ? 0o600 : 0o700);
}

const pathProfile = 'PATH="$HOME/.local/bin:$PATH"\nexport PATH\n';
for (const name of [".profile", ".bash_profile", ".zprofile"]) {
  writeFileSync(path.join(home, name), pathProfile, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

writeFileSync(
  path.join(stateRoot, "workspace-performance-home-setup.json"),
  `${JSON.stringify({ installed, schema: 1 })}\n`,
  { encoding: "utf8", flag: "wx", mode: 0o600 },
);
