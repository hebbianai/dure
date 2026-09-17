#!/usr/bin/env python3
"""Generate public Hmux TUF verifier fixtures with disposable in-memory keys.

Run with the exact, reviewed packages:

    uv run --no-project \
      --with 'tuf==7.0.0' \
      --with 'securesystemslib[crypto]==1.3.1' \
      python scripts/qa/generate-hmux-tuf-fixtures.py \
      --output /path/to/new/empty/output

The script persists public metadata and harmless target archives only. Signing
keys exist in process memory for this disposable rehearsal and are never
written to the output directory.
"""

from __future__ import annotations

import argparse
import copy
import gzip
import hashlib
import io
import json
import tarfile
from datetime import datetime, timezone
from pathlib import Path

from securesystemslib.signer import CryptoSigner
from tuf.api.metadata import (
    MetaFile,
    Metadata,
    Root,
    Snapshot,
    TargetFile,
    Targets,
    Timestamp,
)
from tuf.api.serialization.json import JSONSerializer

SERIALIZER = JSONSerializer(compact=False)
FUTURE_EXPIRY = datetime(2037, 1, 1, tzinfo=timezone.utc)
LONG_EXPIRY = datetime(2099, 1, 1, tzinfo=timezone.utc)
PAST_EXPIRY = datetime(2020, 1, 1, tzinfo=timezone.utc)
MAX_TARGET_BYTES = 256 * 1024 * 1024
TARGET_TRIPLES = (
    "x86_64-unknown-linux-musl",
    "aarch64-unknown-linux-musl",
)


def target_archive(triple: str, version: str) -> tuple[bytes, str]:
    payload = f"hmux fixture {version} {triple}\n".encode()
    tar_bytes = io.BytesIO()
    with tarfile.open(fileobj=tar_bytes, mode="w", format=tarfile.PAX_FORMAT) as tar:
        member = tarfile.TarInfo("bin/hmux-runtime")
        member.size = len(payload)
        member.mode = 0o755
        member.mtime = 0
        member.uid = 0
        member.gid = 0
        member.uname = ""
        member.gname = ""
        tar.addfile(member, io.BytesIO(payload))
    archive = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=archive, mtime=0) as stream:
        stream.write(tar_bytes.getvalue())
    return archive.getvalue(), hashlib.sha256(payload).hexdigest()


def new_authority(channel: str) -> dict[str, object]:
    root_signers = [CryptoSigner.generate_ed25519() for _ in range(3)]
    replacement_root_signer = CryptoSigner.generate_ed25519()
    targets_signers = [CryptoSigner.generate_ed25519() for _ in range(3)]
    snapshot_signer = CryptoSigner.generate_ed25519()
    timestamp_signer = CryptoSigner.generate_ed25519()

    root_v1 = Root(
        version=1,
        expires=FUTURE_EXPIRY,
        consistent_snapshot=True,
        unrecognized_fields={"x-hmux-channel": channel},
    )
    for signer in root_signers:
        root_v1.add_key(signer.public_key, "root")
    for signer in targets_signers:
        root_v1.add_key(signer.public_key, "targets")
    root_v1.add_key(snapshot_signer.public_key, "snapshot")
    root_v1.add_key(timestamp_signer.public_key, "timestamp")
    root_v1.roles["root"].threshold = 2
    root_v1.roles["targets"].threshold = 2

    root_v1_metadata = Metadata(root_v1)
    for signer in root_signers[:2]:
        root_v1_metadata.sign(signer, append=True)

    root_v2 = copy.deepcopy(root_v1)
    root_v2.version = 2
    root_v2.revoke_key(root_signers[0].public_key.keyid, "root")
    root_v2.add_key(replacement_root_signer.public_key, "root")
    root_v2_metadata = Metadata(root_v2)
    # old threshold: old-0 + old-1; new threshold: old-1 + replacement.
    for signer in (root_signers[0], root_signers[1], replacement_root_signer):
        root_v2_metadata.sign(signer, append=True)

    return {
        "root_signers": root_signers,
        "replacement_root_signer": replacement_root_signer,
        "targets_signers": targets_signers,
        "snapshot_signer": snapshot_signer,
        "timestamp_signer": timestamp_signer,
        "root_v1": root_v1_metadata,
        "root_v2": root_v2_metadata,
        "root_v2_signers": (
            root_signers[1],
            root_signers[2],
            replacement_root_signer,
        ),
    }


def build_roles(
    channel: str,
    authority: dict[str, object],
    version: int,
    *,
    expired_timestamp: bool = False,
    expiry_role: str | None = None,
    extra_targets: int = 0,
    oversized_target: bool = False,
    custom_overrides: dict[str, object] | None = None,
    targets_signature_count: int = 2,
    sign_snapshot: bool = True,
    sign_timestamp: bool = True,
    padding_role: str | None = None,
) -> tuple[Metadata, Metadata, Metadata, dict[str, tuple[bytes, str]]]:
    targets = Metadata(
        Targets(
            version=version,
            expires=LONG_EXPIRY if expiry_role == "targets" else FUTURE_EXPIRY,
        )
    )
    target_blobs: dict[str, tuple[bytes, str]] = {}
    package_version = f"0.1.{3 + version}"

    for triple in TARGET_TRIPLES:
        archive, installed_tree_sha256 = target_archive(triple, package_version)
        build_id = f"{package_version}+fixture.{triple}.release"
        # Keep the logical target flat. tough 0.24 prefixes the complete path
        # for consistent snapshots instead of prefixing only the basename,
        # which is not interoperable for nested target paths.
        target_name = f"{build_id}.tar.gz"
        target = TargetFile.from_data(target_name, archive, ["sha256"])
        custom = {
            "schemaVersion": 1,
            "product": "hmux",
            "channel": channel,
            "buildId": build_id,
            "sourceCommit": hashlib.sha1(
                f"{channel}-{version}".encode(), usedforsecurity=False
            ).hexdigest(),
            "targetTriple": triple,
            "archiveFormat": "tar.gz",
            "packageVersion": package_version,
            "protocolMinimum": "1.0",
            "protocolMaximum": "1.0",
            "installedTreeSha256": installed_tree_sha256,
        }
        if custom_overrides:
            custom.update(custom_overrides)
        target.unrecognized_fields["custom"] = custom
        if oversized_target and triple == TARGET_TRIPLES[0]:
            target.length = MAX_TARGET_BYTES + 1
        targets.signed.targets[target_name] = target
        target_blobs[target_name] = (archive, target.hashes["sha256"])

    for index in range(extra_targets):
        name = f"extra-{index:02}.x86_64-unknown-linux-musl.release.tar.gz"
        blob = f"extra target {index}\n".encode()
        target = TargetFile.from_data(name, blob, ["sha256"])
        target.unrecognized_fields["custom"] = {
            "schemaVersion": 1,
            "product": "hmux",
            "channel": channel,
            "buildId": name.removesuffix(".tar.gz"),
            "sourceCommit": hashlib.sha1(
                f"extra-{channel}-{index}".encode(), usedforsecurity=False
            ).hexdigest(),
            "targetTriple": TARGET_TRIPLES[0],
            "archiveFormat": "tar.gz",
            "packageVersion": package_version,
            "protocolMinimum": "1.0",
            "protocolMaximum": "1.0",
            "installedTreeSha256": hashlib.sha256(blob).hexdigest(),
        }
        targets.signed.targets[name] = target
        target_blobs[name] = (blob, target.hashes["sha256"])

    if padding_role == "targets":
        targets.signed.unrecognized_fields["x-padding"] = "x" * (2 * 1024 * 1024)
    for signer in authority["targets_signers"][:targets_signature_count]:
        targets.sign(signer, append=True)
    targets_bytes = targets.to_bytes(SERIALIZER)

    snapshot = Metadata(
        Snapshot(
            version=version,
            expires=LONG_EXPIRY if expiry_role == "snapshot" else FUTURE_EXPIRY,
            meta={
                "targets.json": MetaFile.from_data(
                    version, targets_bytes, ["sha256"]
                )
            },
        )
    )
    if padding_role == "snapshot":
        snapshot.signed.unrecognized_fields["x-padding"] = "x" * (512 * 1024)
    if sign_snapshot:
        snapshot.sign(authority["snapshot_signer"])
    snapshot_bytes = snapshot.to_bytes(SERIALIZER)

    timestamp = Metadata(
        Timestamp(
            version=version,
            expires=(
                PAST_EXPIRY
                if expired_timestamp
                else LONG_EXPIRY
                if expiry_role == "timestamp"
                else FUTURE_EXPIRY
            ),
            snapshot_meta=MetaFile.from_data(
                version, snapshot_bytes, ["sha256"]
            ),
        )
    )
    if padding_role == "timestamp":
        timestamp.signed.unrecognized_fields["x-padding"] = "x" * (64 * 1024)
    if sign_timestamp:
        timestamp.sign(authority["timestamp_signer"])
    return targets, snapshot, timestamp, target_blobs


def write_repository(
    repository_path: Path,
    authority: dict[str, object],
    roles: tuple[Metadata, Metadata, Metadata, dict[str, tuple[bytes, str]]],
) -> None:
    metadata_path = repository_path / "metadata"
    targets_path = repository_path / "targets"
    metadata_path.mkdir(parents=True)
    targets_path.mkdir()

    (metadata_path / "1.root.json").write_bytes(
        authority["root_v1"].to_bytes(SERIALIZER)
    )
    (metadata_path / "2.root.json").write_bytes(
        authority["root_v2"].to_bytes(SERIALIZER)
    )
    targets, snapshot, timestamp, target_blobs = roles
    version = targets.signed.version
    (metadata_path / f"{version}.targets.json").write_bytes(
        targets.to_bytes(SERIALIZER)
    )
    (metadata_path / f"{version}.snapshot.json").write_bytes(
        snapshot.to_bytes(SERIALIZER)
    )
    (metadata_path / "timestamp.json").write_bytes(
        timestamp.to_bytes(SERIALIZER)
    )

    for target_name, (target_bytes, sha256) in target_blobs.items():
        target_path = targets_path / f"{sha256}.{target_name}"
        target_path.write_bytes(target_bytes)


def write_adversarial_roots(output: Path, authority: dict[str, object]) -> None:
    root_v2 = json.loads(authority["root_v2"].to_bytes(SERIALIZER))
    old_key_ids = {
        signer.public_key.keyid for signer in authority["root_signers"]
    }
    new_key_ids = set(root_v2["signed"]["roles"]["root"]["keyids"])
    signatures = root_v2["signatures"]
    variants = {
        # New threshold remains valid; old threshold is one.
        "missing-old-threshold": [
            signature
            for signature in signatures
            if signature["keyid"] in new_key_ids
        ],
        # Old threshold remains valid; new threshold is one.
        "missing-new-threshold": [
            signature
            for signature in signatures
            if signature["keyid"] in old_key_ids
        ],
    }

    adversarial_path = output / "adversarial"
    adversarial_path.mkdir()
    for name, variant_signatures in variants.items():
        document = copy.deepcopy(root_v2)
        document["signatures"] = variant_signatures
        (adversarial_path / f"{name}.2.root.json").write_text(
            json.dumps(document, indent=2) + "\n"
        )

    duplicate = copy.deepcopy(root_v2)
    duplicate["signatures"].append(copy.deepcopy(duplicate["signatures"][0]))
    (adversarial_path / "duplicate-signature.2.root.json").write_text(
        json.dumps(duplicate, indent=2) + "\n"
    )

    corrupt = copy.deepcopy(root_v2)
    corrupt["signatures"][0]["sig"] = (
        "00" + corrupt["signatures"][0]["sig"][2:]
    )
    (adversarial_path / "corrupt-signature.2.root.json").write_text(
        json.dumps(corrupt, indent=2) + "\n"
    )

    def signed_variant(name: str, mutate) -> None:
        signed = copy.deepcopy(authority["root_v2"].signed)
        mutate(signed)
        metadata = Metadata(signed)
        for signer in (
            authority["root_signers"][0],
            authority["root_signers"][1],
            authority["replacement_root_signer"],
        ):
            metadata.sign(signer, append=True)
        (adversarial_path / f"{name}.2.root.json").write_bytes(
            metadata.to_bytes(SERIALIZER)
        )

    signed_variant(
        "targets-threshold-downgrade",
        lambda root: setattr(root.roles["targets"], "threshold", 1),
    )

    def add_online_key(root: Root) -> None:
        signer = CryptoSigner.generate_rsa()
        root.add_key(signer.public_key, "timestamp")

    signed_variant("timestamp-extra-rsa-key", add_online_key)
    signed_variant(
        "unsupported-spec-version",
        lambda root: setattr(root, "spec_version", "2.0.0"),
    )
    signed_variant(
        "long-expiry",
        lambda root: setattr(root, "expires", LONG_EXPIRY),
    )

    def pad_root(root: Root) -> None:
        root.unrecognized_fields["x-padding"] = "x" * (512 * 1024)

    signed_variant("oversized", pad_root)


def write_rotation_repository(
    output: Path,
    authority: dict[str, object],
    final_version: int,
) -> None:
    roles = build_roles("stable", authority, 1)
    write_repository(output, authority, roles)
    for version in range(3, final_version + 1):
        root = copy.deepcopy(authority["root_v2"].signed)
        root.version = version
        metadata = Metadata(root)
        for signer in authority["root_v2_signers"][:2]:
            metadata.sign(signer, append=True)
        (output / "metadata" / f"{version}.root.json").write_bytes(
            metadata.to_bytes(SERIALIZER)
        )


def write_readme(output: Path) -> None:
    (output / "README.md").write_text(
        """# Public Hmux TUF verifier fixtures

These repositories were generated by
`scripts/qa/generate-hmux-tuf-fixtures.py` using:

- `tuf 7.0.0`, source `353bdb767db56fd4667c9bcf56b710d50fdc2ac0`,
  wheel SHA-256
  `572bdbdc9ff4a82278a0d4773e6100863b9b33023f27575e84ca65b486dd0d79`;
- `securesystemslib 1.3.1`, source
  `6f774190b90f0aa9d5d7e077680adbaa29c5cd6c`, wheel SHA-256
  `2e5414bbdde33155a91805b295cbedc4ae3f12b48dccc63e1089093537f43c81`.

All keys were disposable and existed only in generator process memory. This
directory contains public signed metadata and harmless target archives only.
The command pins the two direct package versions, while the generated output
manifest—not an unrecorded local Python environment—is the review authority.
Regeneration creates a new disposable public authority and must include a full
fixture diff; it is not claimed to reproduce the same signatures byte for byte.
The 2037 fixture expiry is deliberately independent of production role
lifetimes so tests do not silently expire; expiry rejection uses the separately
signed `stable-expired-timestamp` repository.

`stable-v1` and `stable-v2` share one authority and exercise metadata rollback.
Stable root v2 replaces one of three root keys and carries enough distinct
signatures for both the old and new 2-of-3 thresholds. Canary has a completely
independent authority.
"""
    )


def write_manifest(output: Path) -> None:
    lines = []
    for file_path in sorted(output.rglob("*")):
        if file_path.is_file() and file_path.name != "MANIFEST.sha256":
            digest = hashlib.sha256(file_path.read_bytes()).hexdigest()
            relative = file_path.relative_to(output).as_posix()
            lines.append(f"{digest}  {relative}")
    (output / "MANIFEST.sha256").write_text("\n".join(lines) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)

    stable = new_authority("stable")
    canary = new_authority("canary")
    write_repository(
        args.output / "stable-v1", stable, build_roles("stable", stable, 1)
    )
    write_repository(
        args.output / "stable-v2", stable, build_roles("stable", stable, 2)
    )
    write_repository(
        args.output / "stable-expired-timestamp",
        stable,
        build_roles("stable", stable, 1, expired_timestamp=True),
    )
    write_repository(
        args.output / "canary-v1", canary, build_roles("canary", canary, 1)
    )
    write_repository(
        args.output / "stable-same-version-changed",
        stable,
        build_roles(
            "stable",
            stable,
            1,
            custom_overrides={"installedTreeSha256": "b" * 64},
        ),
    )
    for role in ("root", "targets", "snapshot", "timestamp"):
        if role == "root":
            continue
        write_repository(
            args.output / f"stable-long-{role}",
            stable,
            build_roles("stable", stable, 1, expiry_role=role),
        )
    write_repository(
        args.output / "stable-too-many-targets",
        stable,
        build_roles("stable", stable, 1, extra_targets=63),
    )
    write_repository(
        args.output / "stable-oversized-target",
        stable,
        build_roles("stable", stable, 1, oversized_target=True),
    )
    for role in ("timestamp", "snapshot", "targets"):
        write_repository(
            args.output / f"stable-oversized-{role}",
            stable,
            build_roles("stable", stable, 1, padding_role=role),
        )
    write_repository(
        args.output / "stable-insufficient-targets-signature",
        stable,
        build_roles("stable", stable, 1, targets_signature_count=1),
    )
    write_repository(
        args.output / "stable-unsigned-snapshot",
        stable,
        build_roles("stable", stable, 1, sign_snapshot=False),
    )
    write_repository(
        args.output / "stable-unsigned-timestamp",
        stable,
        build_roles("stable", stable, 1, sign_timestamp=False),
    )
    for name, custom in (
        ("wrong-product", {"product": "other"}),
        ("wrong-archive", {"archiveFormat": "zip"}),
        ("wrong-protocol", {"protocolMinimum": "2.0", "protocolMaximum": "2.0"}),
    ):
        write_repository(
            args.output / f"stable-custom-{name}",
            stable,
            build_roles("stable", stable, 1, custom_overrides=custom),
        )
    write_rotation_repository(args.output / "stable-32-root-rotations", stable, 33)
    write_rotation_repository(args.output / "stable-33-root-rotations", stable, 34)
    write_adversarial_roots(args.output, stable)
    write_readme(args.output)
    write_manifest(args.output)


if __name__ == "__main__":
    main()
