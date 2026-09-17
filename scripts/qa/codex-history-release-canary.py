"""Qualify official Codex artifacts without installing or authenticating them."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import runpy
import shutil
import tarfile
import tempfile
import urllib.request


def read_json(url):
    with urllib.request.urlopen(url, timeout=30) as response:
        return json.load(response)


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def qualify(selector, output):
    output.mkdir(parents=True, exist_ok=False, mode=0o700)
    if (platform.system(), platform.machine()) != ("Darwin", "arm64"):
        raise RuntimeError("This canary qualifies macOS arm64 artifacts only")
    version = selector
    if selector in ("latest", "alpha"):
        version = read_json(f"https://registry.npmjs.org/@openai/codex/{selector}")["version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:-alpha\.\d+)?", version):
        raise RuntimeError("Unrecognized Codex release version")
    asset_name = "codex-aarch64-apple-darwin.tar.gz"
    release = read_json(f"https://api.github.com/repos/openai/codex/releases/tags/rust-v{version}")
    asset = next(item for item in release["assets"] if item["name"] == asset_name)
    expected = asset.get("digest", "")
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", expected):
        raise RuntimeError("Official release asset has no SHA-256 digest")
    url = f"https://github.com/openai/codex/releases/download/rust-v{version}/{asset_name}"
    smoke = runpy.run_path(str(Path(__file__).with_name("codex-account-resume-history-smoke.py")))
    with tempfile.TemporaryDirectory(prefix="dure-codex-artifact-") as temporary:
        archive = Path(temporary) / asset_name
        with urllib.request.urlopen(url, timeout=60) as response, archive.open("wb") as destination:
            shutil.copyfileobj(response, destination)
        digest = sha256(archive)
        if expected != f"sha256:{digest}":
            raise RuntimeError("Downloaded provider archive does not match official digest")
        executable = Path(temporary) / "codex"
        with tarfile.open(archive) as source:
            member = source.getmember("codex-aarch64-apple-darwin")
            if not member.isfile():
                raise RuntimeError("Provider archive entry is not a regular file")
            with source.extractfile(member) as binary, executable.open("wb") as destination:
                shutil.copyfileobj(binary, destination)
        executable.chmod(0o700)
        executable_digest = sha256(executable)
        result = smoke["check"](executable, output)
        if any(not result[key]["userAgent"].startswith(f"dure-history-fixture/{version} ")
               for key in ("firstResume", "secondResume")):
            raise RuntimeError("Running provider version differs from selected artifact")
        terminal_smoke = runpy.run_path(str(Path(__file__).with_name("codex-terminal-resume-history-smoke.py")))
        terminal_root = output / "terminal"
        terminal_root.mkdir(mode=0o700)
        result["terminalHistory"] = terminal_smoke["check"](executable, terminal_root)
    # The known-bad control must reproduce BOTH observed failures. A startup,
    # RPC, or download error is never accepted as expected regression evidence.
    known_regression = version == "0.153.4"
    expected_failures = [
        "native resume reused a durable rollout ordinal",
        "second account resumed stale displayed history",
    ]
    accepted = result["failures"] == expected_failures if known_regression else result["ok"]
    accepted = accepted and result["terminalHistory"]["ok"]
    result.update(
        selector=selector, version=version, archiveSha256=digest,
        executableSha256=executable_digest,
        disposition=("known_regression" if known_regression else "qualified") if accepted else "rejected",
        canaryPassed=accepted,
    )
    (output / "receipt.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({key: result[key] for key in (
        "selector", "version", "disposition", "canaryPassed", "executableSha256",
    )}), flush=True)
    return 0 if accepted else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--selector", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        status = qualify(args.selector, args.output.resolve())
    except Exception as error:
        args.output.mkdir(parents=True, exist_ok=True)
        (args.output / "error.json").write_text(json.dumps({"error": str(error)}) + "\n")
        raise
    raise SystemExit(status)
