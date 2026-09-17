#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 <guest-root> <source-commit> <conformance-commit>" >&2
  exit 2
fi

guest_root=$1
source_commit=$2
conformance_commit=$3
snapshot=20260725T000000Z
rust_version=1.85.0
rust_digest=024918027c349bd237617a8a1207d7c4462f70549a31e8bf6c14b0601cfd489e
image_digest=2eaec7286c49fdea713dddabcf5012cafa7097a658e916acb48f4bc5fdc8e419

[[ $guest_root =~ ^/tmp/hmux-tuf-conformance-[A-Za-z0-9.-]+$ ]]
[[ $source_commit =~ ^[0-9a-f]{40}$ ]]
[[ $conformance_commit == 51ee32b3a7cee80d4f998b164357d7c78fe7c541 ]]

incoming=$guest_root/incoming
evidence=$guest_root/evidence
raw_log=$guest_root/.pytest.log
raw_report=$guest_root/.pytest-report.json
current_phase=bootstrap
succeeded=false
mkdir -m 700 "$evidence"

write_failure() {
  local exit_code=$1
  local detail_digest=unavailable
  if [[ -f $raw_log ]]; then
    detail_digest=$(sha256sum "$raw_log" | cut -d ' ' -f 1)
  fi
  python3 - "$current_phase" "$exit_code" "$detail_digest" \
    "$source_commit" "$conformance_commit" >"$evidence/failure.json" <<'PY'
import json
import sys

print(json.dumps({
    "ok": False,
    "phase": sys.argv[1],
    "exitCode": int(sys.argv[2]),
    "detailRedacted": True,
    "redactedDetailSha256": sys.argv[3],
    "sourceCommit": sys.argv[4],
    "conformanceCommit": sys.argv[5],
}, sort_keys=True, separators=(",", ":")))
PY
}

on_exit() {
  local exit_code=$?
  trap - EXIT HUP INT TERM
  rm -rf "$evidence/apt-debs"
  if [[ $succeeded != true ]]; then
    write_failure "$exit_code" || true
  fi
  rm -f "$raw_log" "$raw_report"
  exit "$exit_code"
}
trap on_exit EXIT
trap 'exit 1' HUP INT TERM

for file in \
  source.tar \
  conformance.tar \
  rust.tar.xz \
  requirements.txt \
  client.xfails \
  audit.py
do
  [[ -f $incoming/$file ]]
done
[[ $(sha256sum "$incoming/rust.tar.xz" | cut -d ' ' -f 1) == "$rust_digest" ]]

current_phase=packages
apt_sources=$guest_root/ubuntu-snapshot.sources.list
snapshot_root=https://snapshot.ubuntu.com/ubuntu/$snapshot
printf '%s\n' \
  "deb [arch=arm64 signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] $snapshot_root noble main universe" \
  "deb [arch=arm64 signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] $snapshot_root noble-updates main universe" \
  "deb [arch=arm64 signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] $snapshot_root noble-security main universe" \
  >"$apt_sources"
apt_options=(
  -o "Dir::Etc::sourcelist=$apt_sources"
  -o "Dir::Etc::sourceparts=-"
  -o "APT::Get::List-Cleanup=0"
)
packages=(
  build-essential=12.10ubuntu1
  cmake=3.28.3-1build7
  python3-venv=3.12.3-0ubuntu2.1
  python3.12-venv=3.12.3-1ubuntu0.15
  python3-pip-whl=24.0+dfsg-1ubuntu1.3
  python3-setuptools-whl=68.1.2-2ubuntu1.2
  faketime=0.9.10-2.1
  libfaketime=0.9.10-2.1
)
sudo apt-get "${apt_options[@]}" update
mkdir -m 700 "$evidence/apt-debs"
(
  cd "$evidence/apt-debs"
  apt-get "${apt_options[@]}" download "${packages[@]}"
  sha256sum ./*.deb >../apt-direct-packages.sha256
)
sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a \
  apt-get "${apt_options[@]}" install --yes --no-install-recommends \
  "${packages[@]}"
dpkg-query -W -f='${binary:Package}\t${Version}\n' |
  LC_ALL=C sort >"$evidence/installed-packages.tsv"
rm -rf "$evidence/apt-debs"

current_phase=toolchain
rust_dist=$guest_root/rust-dist
mkdir -m 700 "$rust_dist"
tar -xJf "$incoming/rust.tar.xz" -C "$rust_dist"
rust_installer=$rust_dist/rust-$rust_version-aarch64-unknown-linux-gnu/install.sh
[[ -x $rust_installer ]]
"$rust_installer" \
  --prefix="$guest_root/rust" \
  --disable-ldconfig \
  --components=rustc,rust-std-aarch64-unknown-linux-gnu,cargo \
  >/dev/null
export PATH="$guest_root/rust/bin:$PATH"
export CARGO_HOME="$guest_root/cargo-home"
export CARGO_TARGET_DIR="$guest_root/cargo-target"
[[ $(rustc -V) == "rustc 1.85.0 (4d91de4e4 2025-02-17)" ]]
[[ $(cargo -V | awk '{print $2}') == "$rust_version" ]]

current_phase=build
source_tree=$guest_root/source
mkdir -m 700 "$source_tree"
tar -xf "$incoming/source.tar" -C "$source_tree"
cargo build --locked --quiet \
  --manifest-path "$source_tree/hmux/Cargo.toml" \
  --package hmux-release-trust \
  --features conformance \
  --example tuf_conformance_client
adapter=$guest_root/client
install -m 0755 \
  "$CARGO_TARGET_DIR/debug/examples/tuf_conformance_client" "$adapter"
install -m 0644 "$incoming/client.xfails" "$adapter.xfails"

current_phase=python
conformance_tree=$guest_root/conformance
mkdir -m 700 "$conformance_tree"
tar -xf "$incoming/conformance.tar" -C "$conformance_tree"
python3 -m venv "$guest_root/venv"
env \
  PIP_CONFIG_FILE=/dev/null \
  PIP_NO_INPUT=1 \
  PIP_ONLY_BINARY=:all: \
  PYTHONNOUSERSITE=1 \
  "$guest_root/venv/bin/python" -m pip \
  install --disable-pip-version-check --require-hashes \
  -r "$incoming/requirements.txt"
[[ $(
  TZ=UTC faketime "2001-02-03 04:05:06" \
    date -u +%Y-%m-%dT%H:%M:%S
) == 2001-02-03T04:05:06 ]]

current_phase=collection
"$guest_root/venv/bin/python" -m pytest \
  --collect-only -q \
  --json-report \
  --json-report-file="$guest_root/collect.json" \
  --entrypoint "$adapter" \
  "$conformance_tree/tuf_conformance" \
  >/dev/null
python3 "$incoming/audit.py" collect \
  "$guest_root/collect.json" \
  "$adapter.xfails" \
  "$evidence/xfail-audit.json"
rm -f "$guest_root/collect.json"

current_phase=conformance
repositories=$guest_root/repositories
mkdir -m 700 "$repositories"
set +e
timeout --kill-after=30s 45m \
  "$guest_root/venv/bin/python" -m pytest \
  --strict-config \
  --strict-markers \
  -o xfail_strict=true \
  -q -ra \
  --json-report \
  --json-report-file="$raw_report" \
  --repository-dump-dir "$repositories" \
  --entrypoint "$adapter" \
  "$conformance_tree/tuf_conformance" \
  >"$raw_log" 2>&1
pytest_status=$?
set -e
[[ $pytest_status -eq 0 ]]
python3 "$incoming/audit.py" result \
  "$raw_report" \
  "$evidence/xfail-audit.json" \
  "$evidence/conformance-summary.json"
sha256sum "$raw_log" >"$evidence/pytest-log.sha256"
(
  cd "$repositories"
  find . -type f -print0 |
    LC_ALL=C sort -z |
    xargs -0 sha256sum >"$evidence/repository-dumps.sha256"
)
rm -rf "$repositories"

current_phase=evidence
{
  printf 'source_commit=%s\n' "$source_commit"
  printf 'conformance_commit=%s\n' "$conformance_commit"
  printf 'ubuntu_snapshot=%s\n' "$snapshot"
  printf 'ubuntu_image_sha256=%s\n' "$image_digest"
  printf 'rust_archive_sha256=%s\n' "$rust_digest"
  rustc -Vv
  cargo -V
  "$guest_root/venv/bin/python" -VV
  sha256sum \
    "$source_tree/hmux/Cargo.lock" \
    "$adapter" \
    "$adapter.xfails" \
    "$incoming/requirements.txt"
  file "$adapter"
  ldd "$adapter"
} >"$evidence/identities.txt"
"$guest_root/venv/bin/python" -m pip freeze \
  >"$evidence/python-packages.txt"

rm -f "$raw_log" "$raw_report"
succeeded=true
