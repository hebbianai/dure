import {
  chmodSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

function regularSource(name) {
  const source = required(name);
  if (!path.isAbsolute(source)) throw new Error(`${name} must be absolute`);
  const metadata = lstatSync(source);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${name} must be a regular file`);
  }
  return source;
}

const stateRoot = realpathSync(required("DURE_QA_STATE_ROOT"));
const home = realpathSync(required("HOME"));
if (home !== realpathSync(path.join(stateRoot, "home"))) {
  throw new Error("SSH receipt-loss HOME escaped its isolated root");
}

const port = Number(required("DURE_QA_SSH_PORT"));
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("DURE_QA_SSH_PORT is invalid");
}
const remoteProject = required("DURE_QA_PROJECT");
if (!path.posix.isAbsolute(remoteProject)) {
  throw new Error("DURE_QA_PROJECT must be absolute");
}

const sshRoot = path.join(home, ".ssh");
mkdirSync(sshRoot, { mode: 0o700 });
chmodSync(sshRoot, 0o700);
const keyPath = path.join(sshRoot, "dure-receipt-loss");
const knownHostsPath = path.join(sshRoot, "known_hosts");
copyFileSync(
  regularSource("DURE_QA_SSH_KEY_SOURCE"),
  keyPath,
  constants.COPYFILE_EXCL,
);
copyFileSync(
  regularSource("DURE_QA_SSH_KNOWN_HOSTS_SOURCE"),
  knownHostsPath,
  constants.COPYFILE_EXCL,
);
chmodSync(keyPath, 0o600);
chmodSync(knownHostsPath, 0o600);

const fixture = {
  name: "receipt-loss",
  host: required("DURE_QA_SSH_HOST"),
  user: required("DURE_QA_SSH_USER"),
  port,
  auth: "key",
  keyPath,
  expectedWorkspacePath: remoteProject,
};
const encoded = Buffer.from(JSON.stringify(fixture)).toString("base64url");
writeFileSync(path.join(stateRoot, "qa.autorun"), `sshproject=${encoded}\n`, {
  encoding: "utf8",
  flag: "wx",
  mode: 0o600,
});
