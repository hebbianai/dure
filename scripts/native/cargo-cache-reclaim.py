#!/usr/bin/env python3
"""Reclaim only compiler inputs, under Cargo's own locks, never runtime outputs."""

import contextlib
import importlib.util
import json
import os
import re
import stat
import sys

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location(
    "directory_authority", os.path.join(os.path.dirname(__file__), "atomic-directory-move.py")
)
directory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(directory)

ARCHIVE = re.compile(r"lib[\w-]+-[0-9a-f]+\.(?:rlib|rmeta)\Z", re.ASCII)
RUST_OBJECT = re.compile(r"[\w-]+(?:\.[\w-]+)+\.rcgu\.o\Z", re.ASCII)
LOCKS = (".cargo-build-lock", ".cargo-lock")
CACHE_TAG = b"Signature: 8a477f597d28d172789f06886806bc55"


def validate_nested_root(root, parts, target_index):
    if len(parts) - target_index <= 3:
        return
    for end in (len(parts) - 1, len(parts) - 2):
        tag = os.path.join(*parts[:end], "CACHEDIR.TAG")
        parent, name = directory.open_parent(root, tag)
        descriptor = None
        try:
            try:
                descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            except FileNotFoundError:
                continue
            metadata = os.fstat(descriptor)
            if stat.S_ISREG(metadata.st_mode) and os.read(descriptor, len(CACHE_TAG)) == CACHE_TAG:
                return
        finally:
            if descriptor is not None:
                os.close(descriptor)
            os.close(parent)
    raise directory.GenerationMismatchError("nested Cargo root has no valid CACHEDIR.TAG")


def open_locks(profile, stack, apply):
    locks = []

    def acquire(name, create=False):
        try:
            descriptor = os.open(
                name, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
                | (os.O_CREAT if create else 0), 0o600,
                dir_fd=profile,
            )
        except FileNotFoundError:
            if create:
                raise
            return
        stack.callback(os.close, descriptor)
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.geteuid() or metadata.st_nlink != 1:
            raise directory.GenerationMismatchError("Cargo lock is not an owned regular file")
        directory.lock_transaction(descriptor)
        locks.append((name, descriptor))

    for name in LOCKS:
        acquire(name)
    if not locks:
        raise directory.GenerationMismatchError("Cargo profile has no existing build lock")
    if apply:
        # A new split-directory consumer can create a previously absent lock.
        # Fence both Cargo generations before deleting; keep these lock inodes
        # in place so waiting consumers cannot acquire an unlinked lock.
        existing = {name for name, _ in locks}
        for name in LOCKS:
            if name not in existing:
                acquire(name, create=True)
    return locks


def validate_locks(profile, locks):
    for name, descriptor in locks:
        if directory.identity(directory.entry_metadata(profile, name)) != directory.identity(os.fstat(descriptor)):
            raise directory.GenerationMismatchError("Cargo lock generation changed")


def visit_incremental(descriptor, apply, tally):
    # The directory stays in place: interruption leaves only rebuildable partial
    # cache contents, and cannot detach or replace a running app's target root.
    for name in os.listdir(descriptor):
        metadata = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
        if stat.S_ISDIR(metadata.st_mode):
            child = directory.open_directory_at(descriptor, name)
            try:
                visit_incremental(child, apply, tally)
            finally:
                os.close(child)
            if apply:
                os.rmdir(name, dir_fd=descriptor)
        elif stat.S_ISREG(metadata.st_mode):
            # Count a shared inode only when deleting its last link. Physical
            # volume observations, not this estimate, decide the free-space goal.
            if apply:
                os.unlink(name, dir_fd=descriptor)
            if metadata.st_nlink == 1:
                tally["bytes"] += metadata.st_blocks * 512
            tally["files"] += 1
        elif stat.S_ISLNK(metadata.st_mode):
            # Never follow a cache link into source or another mount.
            if apply:
                os.unlink(name, dir_fd=descriptor)
        else:
            raise directory.GenerationMismatchError("incremental cache contains a special file")


def is_macho_object(descriptor, name, metadata):
    file = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=descriptor)
    try:
        if directory.identity(os.fstat(file)) != directory.identity(metadata):
            raise directory.GenerationMismatchError("Rust object generation changed")
        header = os.read(file, 32)
        # Unpacked macOS Rust debug/codegen objects are MH_OBJECT, not loadable
        # executables or libraries. Keep unknown formats and renamed runtimes.
        return len(header) == 32 and header[:4] == b"\xcf\xfa\xed\xfe" and header[12:16] == b"\x01\x00\x00\x00"
    finally:
        os.close(file)


def visit_dependencies(descriptor, apply, tally):
    for name in os.listdir(descriptor):
        rust_object = RUST_OBJECT.fullmatch(name)
        if not ARCHIVE.fullmatch(name) and not rust_object:
            continue
        metadata = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1 or metadata.st_mode & 0o111:
            continue
        if rust_object and not is_macho_object(descriptor, name, metadata):
            continue
        if apply:
            os.unlink(name, dir_fd=descriptor)
        tally["bytes"] += metadata.st_blocks * 512
        tally["files"] += 1


def reclaim(request):
    root_path = request["root"]
    relative = request["profile"]
    parts = directory.components(relative)
    if "target" not in parts:
        raise directory.GenerationMismatchError("cache is outside a target directory")
    target_index = len(parts) - 1 - parts[::-1].index("target")
    if not 2 <= len(parts) - target_index <= 6 or any(part.startswith(".") for part in parts[target_index + 1:]):
        raise directory.GenerationMismatchError("unrecognized Cargo profile layout")
    expected_root = (request["rootIdentity"]["device"], request["rootIdentity"]["inode"])
    expected_profile = (request["profileIdentity"]["device"], request["profileIdentity"]["inode"])
    tally = {"bytes": 0, "files": 0}
    apply = request["operation"] == "apply"
    with contextlib.ExitStack() as stack:
        root = directory.open_root(root_path, expected_root)
        stack.callback(os.close, root)
        validate_nested_root(root, parts, target_index)
        parent, name = directory.open_parent(root, relative)
        stack.callback(os.close, parent)
        profile = directory.open_directory_at(parent, name)
        stack.callback(os.close, profile)
        if not directory.matches_identity(os.fstat(profile), expected_profile):
            raise directory.GenerationMismatchError("Cargo profile generation changed")
        # Scope comes from registered-worktree discovery. Also prove the Cargo
        # manifest inside that same pinned root at the destructive boundary.
        manifest_parts = parts[:target_index] + ["Cargo.toml"]
        manifest_parent, manifest_name = directory.open_parent(root, os.path.join(*manifest_parts))
        try:
            manifest = directory.entry_metadata(manifest_parent, manifest_name)
            if not stat.S_ISREG(manifest.st_mode):
                raise directory.GenerationMismatchError("target has no direct Cargo manifest")
        finally:
            os.close(manifest_parent)
        locks = open_locks(profile, stack, apply)
        validate_locks(profile, locks)
        children = []
        try:
            for name, visitor in (("incremental", visit_incremental), ("deps", visit_dependencies)):
                try:
                    metadata = os.stat(name, dir_fd=profile, follow_symlinks=False)
                except FileNotFoundError:
                    continue
                if not stat.S_ISDIR(metadata.st_mode):
                    raise directory.GenerationMismatchError("compiler cache is not a direct directory")
                child = directory.open_directory_at(profile, name)
                stack.callback(os.close, child)
                children.append((child, visitor))
            for child, visitor in children:
                validate_locks(profile, locks)
                visitor(child, apply, tally)
        except Exception as error:
            # A partial cache removal is safe but must never be reported as a
            # successful complete operation or silently lose its byte count.
            return {"state": "refused", "reason": str(error), "removedBytes": tally["bytes"] if apply else 0}
    return {"state": "removed" if apply else "available", **tally}


def main():
    try:
        if not directory.SUPPORTED_PLATFORM:
            raise directory.UnsupportedError("cache-only reclaim requires a supported local Unix filesystem")
        request = json.loads(sys.stdin.buffer.read(16 * 1024))
        if request.get("operation") not in ("inspect", "apply"):
            raise ValueError("invalid cache operation")
        result = reclaim(request)
    except directory.TransactionBusyError:
        result = {"state": "busy", "reason": "cargo-build-lock-held"}
    except Exception as error:
        result = {"state": "refused", "reason": str(error)}
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    main()
