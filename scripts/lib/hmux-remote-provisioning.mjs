// Pure decision logic for pushing a prebuilt Hmux onto a server that may never
// have had one. Everything here is a function of strings, so the interesting
// cases — an unknown architecture, a build id already filed under different
// bytes, a host that is already correct — are testable without an ssh
// connection. The IO lives in scripts/provision-hmux-remote.mjs.

// Only the artifacts something actually publishes. The Linux entries are the
// statically linked musl builds from `.github/workflows/hmux-linux-artifacts.yml`;
// they are chosen over a glibc build precisely so the server's distribution and
// libc version stop mattering. The Darwin entries are here because a Mac can be
// a session box too, but nothing publishes them — a caller only gets one by
// packaging it with scripts/package-hmux-prebuilt.sh first.
//
// Deliberately a table with no default. A guessed triple that installs and then
// fails to exec is the worst possible failure for this path: it happens after
// `current` has moved, on a machine nobody is watching, and the symptom is a
// phone that cannot attach rather than an install that said no.
export const PREBUILT_TRIPLE_BY_PLATFORM = {
  "Linux x86_64": "x86_64-unknown-linux-musl",
  "Linux amd64": "x86_64-unknown-linux-musl",
  "Linux aarch64": "aarch64-unknown-linux-musl",
  "Linux arm64": "aarch64-unknown-linux-musl",
  "Darwin arm64": "aarch64-apple-darwin",
  "Darwin x86_64": "x86_64-apple-darwin",
};

export class HostRefusal extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "HostRefusal";
    this.reason = reason;
  }
}

export function selectPrebuiltTriple({ system, machine }) {
  if (!system || !machine) {
    throw new HostRefusal(
      "undetected-platform",
      "the remote did not report both `uname -s` and `uname -m`",
    );
  }
  const triple = PREBUILT_TRIPLE_BY_PLATFORM[`${system} ${machine}`];
  if (!triple) {
    throw new HostRefusal(
      "unsupported-platform",
      `no Hmux artifact is published for ${system} ${machine}`,
    );
  }
  return triple;
}

// Quoting for values that are interpolated into a command line the remote shell
// will parse. Every value that crosses this boundary — build ids, staging paths
// — goes through it, including the ones another script already constrained to a
// safe character set: the constraint lives in a different file and can be
// relaxed there without anyone remembering that this file depended on it.
export function quoteForRemoteShell(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

// One round trip that answers everything needed to choose an artifact and to
// tell an install apart from a no-op. `readlink` rather than `realpath`: the
// installed `current` is a relative link (`versions/<build id>`), which is what
// makes a version store relocatable, and realpath would erase that.
export function buildProbeScript() {
  return [
    "set -eu",
    'printf "probe=1\\n"',
    'printf "system=%s\\n" "$(uname -s)"',
    'printf "machine=%s\\n" "$(uname -m)"',
    'hmux_root="$HOME/.local/share/hmux"',
    'if [ -L "$hmux_root/current" ]; then',
    '  printf "current=%s\\n" "$(readlink "$hmux_root/current")"',
    "fi",
    'if [ -d "$hmux_root/versions" ]; then',
    '  for hmux_entry in "$hmux_root/versions"/*; do',
    '    [ -d "$hmux_entry" ] || continue',
    '    printf "version=%s\\n" "${hmux_entry##*/}"',
    "  done",
    "fi",
  ].join("\n");
}

export function parseProbeOutput(text) {
  const fields = new Map();
  const versions = [];
  for (const line of String(text).split("\n")) {
    const separator = line.indexOf("=");
    if (separator < 0) {
      continue;
    }
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1).trim();
    if (key === "version") {
      versions.push(value);
      continue;
    }
    fields.set(key, value);
  }
  // An ssh session that prints a banner, or a shell that dies before the probe
  // runs, still exits 0 often enough that a missing marker has to be the
  // failure rather than an empty `system`.
  if (fields.get("probe") !== "1") {
    throw new HostRefusal(
      "unreadable-probe",
      "the remote did not return a readable Hmux probe",
    );
  }
  return {
    system: fields.get("system") ?? "",
    machine: fields.get("machine") ?? "",
    current: fields.get("current") ?? null,
    versions,
  };
}

// `installedDigest` is the digest of the remote `versions/<buildId>` tree, or
// null when that directory does not exist. It is deliberately a separate input
// rather than something this function fetches, so that the refusal cases are
// reachable in a test without a remote.
export function planHostAction({
  buildId,
  expectedDigest,
  installedDigest,
  probe,
}) {
  if (!probe.versions.includes(buildId)) {
    return { action: "install" };
  }
  if (!installedDigest) {
    // The version directory exists but would not hash. Fail closed: the only
    // other move is to push over it, and pushing over an unreadable immutable
    // build is exactly the thing the store exists to prevent.
    return {
      action: "refuse",
      reason: "unreadable-installed-build",
      message:
        `${buildId} is already filed on this host but its tree could not be ` +
        "hashed; inspect ~/.local/share/hmux/versions/" +
        `${buildId} by hand before provisioning again`,
    };
  }
  if (installedDigest !== expectedDigest) {
    // The immutable store would refuse this on its own, with a one-line
    // "refusing to replace immutable Hmux build". Catching it here instead
    // means the operator is told *why* the two disagree and what to do, and
    // means no bytes are uploaded to a host that was never going to accept
    // them.
    return {
      action: "refuse",
      reason: "build-id-conflict",
      message:
        `${buildId} is already installed on this host with different bytes ` +
        `(host ${installedDigest}, artifact ${expectedDigest}); nothing was ` +
        "changed. Publish the new build under its own build id, or remove " +
        `~/.local/share/hmux/versions/${buildId} after confirming no Host is ` +
        "running from it",
    };
  }
  if (probe.current === `versions/${buildId}`) {
    return { action: "none" };
  }
  // Right bytes, wrong `current`: a previous run was interrupted between the
  // copy and the symlink swap, or an operator rolled back. Re-running the
  // installer is the correct repair, and it is not a no-op, so it does not get
  // to claim it was one.
  return { action: "activate" };
}

export function summarizeResults(results) {
  const failed = results.filter((result) => result.outcome === "failed");
  const changed = results.filter(
    (result) => result.outcome === "installed" || result.outcome === "activated",
  );
  const unchanged = results.filter(
    (result) => result.outcome === "already-current",
  );
  return {
    changed: changed.map((result) => result.host),
    failed: failed.map((result) => result.host),
    total: results.length,
    unchanged: unchanged.map((result) => result.host),
  };
}
