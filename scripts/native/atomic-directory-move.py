#!/usr/bin/env python3

import ctypes
import errno
import json
import os
import stat
import sys

try:
    import fcntl
except ImportError:
    fcntl = None


CONFLICT = 3
UNSUPPORTED = 4
FAILURE = 5
GENERATION_MISMATCH = 6
TRANSACTION_BUSY = 7
SUPPORTED_PLATFORM = sys.platform == "darwin" or sys.platform.startswith("linux")
AT_FDCWD = -2 if sys.platform == "darwin" else -100
RENAME_NOREPLACE = 0x00000001
RENAME_EXCL = 0x00000004
DIRECTORY_FLAGS = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_CLOEXEC", 0)
DIRECTORY_NOFOLLOW_FLAGS = DIRECTORY_FLAGS | getattr(os, "O_NOFOLLOW", 0)
CLAIM_SCHEMA = "dure-directory-generation-claim/v1"
CONTROL_DIRECTORY = ".dure-reclaim"
MANIFEST = "claim.json"
MAX_MANIFEST_BYTES = 16 * 1024
UNSUPPORTED_ERRNOS = {errno.EINVAL, errno.ENOSYS}
for error_name in ("ENOTSUP", "EOPNOTSUPP"):
    error_number = getattr(errno, error_name, None)
    if error_number is not None:
        UNSUPPORTED_ERRNOS.add(error_number)


class NativeStatusError(Exception):
    exit_code = FAILURE


class ConflictError(NativeStatusError):
    exit_code = CONFLICT


class UnsupportedError(NativeStatusError):
    exit_code = UNSUPPORTED


class GenerationMismatchError(NativeStatusError):
    exit_code = GENERATION_MISMATCH


class TransactionBusyError(NativeStatusError):
    exit_code = TRANSACTION_BUSY


def identity(metadata):
    return str(metadata.st_dev), str(metadata.st_ino)


def generation(metadata):
    return str(metadata.st_dev), str(metadata.st_ino), str(metadata.st_ctime_ns)


def identity_value(metadata):
    device, inode = identity(metadata)
    return {"device": device, "inode": inode}


def generation_value(metadata):
    device, inode, change = generation(metadata)
    return {"device": device, "inode": inode, "change": change}


def matches_identity(metadata, expected):
    return identity(metadata) == expected


def matches_generation(metadata, expected):
    return generation(metadata) == expected


def components(relative_path):
    if os.path.isabs(relative_path):
        raise GenerationMismatchError("absolute relative path")
    values = relative_path.split(os.sep)
    if not values or any(value in ("", ".", "..") for value in values):
        raise GenerationMismatchError("invalid relative path")
    return values


def mount_id(descriptor):
    if not sys.platform.startswith("linux"):
        return None
    try:
        with open(f"/proc/self/fdinfo/{descriptor}", encoding="utf8") as stream:
            for line in stream:
                if line.startswith("mnt_id:"):
                    return line.split(":", 1)[1].strip()
    except OSError as error:
        raise UnsupportedError(f"mount identity unavailable: {error}") from error
    raise UnsupportedError("mount identity unavailable: missing mnt_id")


def assert_same_mount(parent, child):
    if os.fstat(parent).st_dev != os.fstat(child).st_dev:
        raise GenerationMismatchError("directory traversal crossed a mount boundary")
    if sys.platform.startswith("linux") and mount_id(parent) != mount_id(child):
        raise GenerationMismatchError("directory traversal crossed a mount boundary")


def open_root(path, expected):
    try:
        descriptor = os.open(path, DIRECTORY_NOFOLLOW_FLAGS)
    except OSError as error:
        raise GenerationMismatchError(f"root is unavailable: {error}") from error
    if not matches_identity(os.fstat(descriptor), expected):
        os.close(descriptor)
        raise GenerationMismatchError("root generation changed")
    return descriptor


def validate_private_directory(descriptor, label):
    metadata = os.fstat(descriptor)
    if metadata.st_uid != os.geteuid() or stat.S_IMODE(metadata.st_mode) != 0o700:
        raise GenerationMismatchError(f"{label} is not owner-only")


def lock_transaction(descriptor):
    if fcntl is None:
        raise UnsupportedError("directory transaction locks are unavailable")
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as error:
        if error.errno in (errno.EACCES, errno.EAGAIN):
            raise TransactionBusyError("directory transaction is active") from error
        raise


def open_directory_at(parent, name, create=False, private=False):
    try:
        descriptor = os.open(name, DIRECTORY_NOFOLLOW_FLAGS, dir_fd=parent)
    except FileNotFoundError:
        if not create:
            raise GenerationMismatchError(f"directory is unavailable: {name}")
        try:
            os.mkdir(name, mode=0o700, dir_fd=parent)
            os.fsync(parent)
        except FileExistsError:
            pass
        try:
            descriptor = os.open(name, DIRECTORY_NOFOLLOW_FLAGS, dir_fd=parent)
        except OSError as error:
            raise GenerationMismatchError(f"directory is unavailable: {name}: {error}") from error
    except OSError as error:
        raise GenerationMismatchError(f"directory is unavailable: {name}: {error}") from error
    try:
        assert_same_mount(parent, descriptor)
        if private:
            validate_private_directory(descriptor, name)
        return descriptor
    except Exception:
        os.close(descriptor)
        raise


def open_parent(root, relative_path):
    values = components(relative_path)
    descriptor = os.dup(root)
    try:
        for name in values[:-1]:
            child = open_directory_at(descriptor, name)
            os.close(descriptor)
            descriptor = child
        return descriptor, values[-1]
    except Exception:
        os.close(descriptor)
        raise


def entry_metadata(parent, name):
    try:
        return os.stat(name, dir_fd=parent, follow_symlinks=False)
    except OSError as error:
        raise GenerationMismatchError(f"directory entry is unavailable: {name}: {error}") from error


def rename_no_replace(source_parent, source, destination_parent, destination):
    libc = ctypes.CDLL(None, use_errno=True)
    encoded_source = os.fsencode(source)
    encoded_destination = os.fsencode(destination)
    if sys.platform == "darwin":
        try:
            operation = libc.renameatx_np
        except AttributeError as error:
            raise UnsupportedError("renameatx_np is unavailable") from error
        operation.argtypes = [
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_uint,
        ]
        operation.restype = ctypes.c_int
        result = operation(
            source_parent,
            encoded_source,
            destination_parent,
            encoded_destination,
            RENAME_EXCL,
        )
    elif sys.platform.startswith("linux"):
        try:
            operation = libc.renameat2
        except AttributeError as error:
            raise UnsupportedError("renameat2 is unavailable") from error
        operation.argtypes = [
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_uint,
        ]
        operation.restype = ctypes.c_int
        result = operation(
            source_parent,
            encoded_source,
            destination_parent,
            encoded_destination,
            RENAME_NOREPLACE,
        )
    else:
        raise UnsupportedError(f"unsupported platform: {sys.platform}")
    if result != 0:
        error_number = ctypes.get_errno()
        detail = f"errno={error_number} {errno.errorcode.get(error_number, 'UNKNOWN')}: {os.strerror(error_number)}"
        if error_number == errno.EEXIST:
            raise ConflictError(detail)
        if error_number in UNSUPPORTED_ERRNOS:
            raise UnsupportedError(detail)
        raise OSError(error_number, detail)
    if source_parent >= 0:
        os.fsync(source_parent)
    if destination_parent >= 0 and destination_parent != source_parent:
        os.fsync(destination_parent)


def write_manifest(transaction, value, replace=False):
    payload = (json.dumps(value, separators=(",", ":")) + "\n").encode("utf8")
    if len(payload) > MAX_MANIFEST_BYTES:
        raise ValueError("claim manifest is too large")
    name = f".{MANIFEST}.{os.getpid()}.tmp" if replace else MANIFEST
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0)
    descriptor = os.open(name, flags, 0o600, dir_fd=transaction)
    try:
        offset = 0
        while offset < len(payload):
            offset += os.write(descriptor, payload[offset:])
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    if replace:
        os.replace(name, MANIFEST, src_dir_fd=transaction, dst_dir_fd=transaction)
    os.fsync(transaction)


def read_manifest(transaction):
    flags = (
        os.O_RDONLY
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0)
        | getattr(os, "O_NONBLOCK", 0)
    )
    try:
        descriptor = os.open(MANIFEST, flags, dir_fd=transaction)
    except OSError as error:
        raise GenerationMismatchError(f"claim manifest is unavailable: {error}") from error
    try:
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != os.geteuid()
            or stat.S_IMODE(metadata.st_mode) != 0o600
            or metadata.st_size <= 0
            or metadata.st_size > MAX_MANIFEST_BYTES
        ):
            raise GenerationMismatchError("claim manifest is not an owner-only regular file")
        payload = b""
        while len(payload) <= MAX_MANIFEST_BYTES:
            chunk = os.read(descriptor, 4096)
            if not chunk:
                break
            payload += chunk
        try:
            return json.loads(payload)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise GenerationMismatchError("claim manifest is malformed") from error
    finally:
        os.close(descriptor)


def manifest_identity(value, field, full=False):
    candidate = value.get(field)
    names = ("device", "inode", "change") if full else ("device", "inode")
    if not isinstance(candidate, dict) or any(
        not isinstance(candidate.get(name), str) or not candidate[name].isdigit()
        for name in names
    ):
        raise GenerationMismatchError(f"claim manifest has an invalid {field}")
    return tuple(candidate[name] for name in names)


def validate_manifest(value, transaction_id, expected_root):
    if (
        not isinstance(value, dict)
        or value.get("schema") != CLAIM_SCHEMA
        or value.get("state") not in ("prepared", "isolated", "removing")
        or value.get("transactionId") != transaction_id
        or not isinstance(value.get("source"), str)
    ):
        raise GenerationMismatchError("claim manifest is not an isolated transaction")
    source = components(value["source"])
    if source[0] == CONTROL_DIRECTORY:
        raise GenerationMismatchError("claim source is inside the control directory")
    if manifest_identity(value, "root") != expected_root:
        raise GenerationMismatchError("claim root generation changed")
    manifest_identity(value, "target", full=True)
    return value


def prepare_transaction(root, transaction_path, prepared):
    values = components(transaction_path)
    if len(values) != 2 or values[0] != CONTROL_DIRECTORY:
        raise GenerationMismatchError("invalid claim transaction path")
    control = open_directory_at(root, CONTROL_DIRECTORY, create=True, private=True)
    transaction = None
    try:
        try:
            os.mkdir(values[1], mode=0o700, dir_fd=control)
            os.fsync(control)
        except FileExistsError as error:
            raise ConflictError("claim transaction already exists") from error
        transaction = open_directory_at(control, values[1], private=True)
        lock_transaction(transaction)
    except Exception:
        if transaction is not None:
            os.close(transaction)
        os.close(control)
        raise
    try:
        write_manifest(transaction, prepared)
    except Exception:
        os.close(transaction)
        try:
            os.rmdir(values[1], dir_fd=control)
            os.fsync(control)
        finally:
            os.close(control)
        raise
    return control, transaction, values[1]


def transaction_metadata_files(transaction):
    with os.scandir(transaction) as entries:
        names = [entry.name for entry in entries]
    for name in names:
        if name != MANIFEST and not (
            name.startswith(f".{MANIFEST}.") and name.endswith(".tmp")
        ):
            raise GenerationMismatchError("claim transaction contains payload")
        metadata = os.stat(name, dir_fd=transaction, follow_symlinks=False)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != os.geteuid()
            or stat.S_IMODE(metadata.st_mode) != 0o600
        ):
            raise GenerationMismatchError("claim metadata is not owner-only")
    return names


def prune_transaction(root, control, transaction, transaction_id, metadata_files):
    for name in metadata_files:
        os.unlink(name, dir_fd=transaction)
    os.fsync(transaction)
    os.rmdir(transaction_id, dir_fd=control)
    os.fsync(control)
    try:
        os.rmdir(CONTROL_DIRECTORY, dir_fd=root)
        os.fsync(root)
    except OSError as error:
        if error.errno not in (errno.ENOENT, errno.ENOTEMPTY):
            raise


def cleanup_transaction(root, control, transaction, transaction_id):
    prune_transaction(
        root,
        control,
        transaction,
        transaction_id,
        transaction_metadata_files(transaction),
    )


def claim_directory(root_path, source_path, transaction_path, root_identity, expected):
    root = source_parent = source_descriptor = control = transaction = None
    try:
        root = open_root(root_path, root_identity)
        source_parent, source_name = open_parent(root, source_path)
        source_descriptor = open_directory_at(source_parent, source_name)
        if not matches_generation(os.fstat(source_descriptor), expected):
            raise GenerationMismatchError("source generation changed before claim")
        transaction_values = components(transaction_path)
        if len(transaction_values) != 2:
            raise GenerationMismatchError("invalid claim transaction path")
        transaction_id = transaction_values[1]
        prepared = {
            "schema": CLAIM_SCHEMA,
            "state": "prepared",
            "transactionId": transaction_id,
            "source": source_path,
            "root": identity_value(os.fstat(root)),
            "target": generation_value(os.fstat(source_descriptor)),
        }
        control, transaction, transaction_id = prepare_transaction(
            root,
            transaction_path,
            prepared,
        )
        rename_no_replace(source_parent, source_name, transaction, "target")
        moved = entry_metadata(transaction, "target")
        held = os.fstat(source_descriptor)
        if identity(moved) != identity(held):
            restored = False
            try:
                rename_no_replace(transaction, "target", source_parent, source_name)
                restored = matches_identity(entry_metadata(source_parent, source_name), identity(moved))
            except Exception:
                restored = False
            if restored:
                cleanup_transaction(root, control, transaction, transaction_id)
                raise GenerationMismatchError(
                    "source generation changed during claim; foreign generation restored"
                )
            raise GenerationMismatchError(
                "source generation changed during claim; foreign generation retained in its transaction"
            )
        isolated = {
            **prepared,
            "state": "isolated",
            "target": generation_value(moved),
        }
        write_manifest(transaction, isolated, replace=True)
        print(json.dumps(isolated, separators=(",", ":")))
    finally:
        for descriptor in (source_descriptor, source_parent, transaction, control, root):
            if descriptor is not None:
                os.close(descriptor)


def open_transaction(root_path, transaction_path, root_identity):
    root = open_root(root_path, root_identity)
    transaction = None
    try:
        values = components(transaction_path)
        if len(values) != 2 or values[0] != CONTROL_DIRECTORY:
            raise GenerationMismatchError("invalid claim transaction path")
        control = open_directory_at(root, CONTROL_DIRECTORY, private=True)
        try:
            transaction = open_directory_at(control, values[1], private=True)
            lock_transaction(transaction)
        except Exception:
            if transaction is not None:
                os.close(transaction)
            os.close(control)
            raise
        return root, control, transaction, values[1]
    except Exception:
        os.close(root)
        raise


def optional_directory_at(parent, name):
    try:
        metadata = os.stat(name, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        return None
    if not stat.S_ISDIR(metadata.st_mode):
        raise GenerationMismatchError(f"claim entry is not a directory: {name}")
    return open_directory_at(parent, name)


def source_directory(root, value):
    parent, name = open_parent(root, value["source"])
    try:
        return optional_directory_at(parent, name)
    finally:
        os.close(parent)


def isolated_value(value, metadata):
    return {
        **value,
        "state": "isolated",
        "target": generation_value(metadata),
    }


def removing_value(value, metadata):
    return {
        **value,
        "state": "removing",
        "target": generation_value(metadata),
    }


def resolved_value(transaction_id):
    return {
        "schema": CLAIM_SCHEMA,
        "state": "resolved",
        "transactionId": transaction_id,
    }


def print_value(value):
    print(json.dumps(value, separators=(",", ":")))


def resolve_metadata_transaction(
    root,
    control,
    transaction,
    transaction_id,
    recover,
):
    metadata_files = transaction_metadata_files(transaction)
    if recover:
        prune_transaction(
            root,
            control,
            transaction,
            transaction_id,
            metadata_files,
        )
    print_value(resolved_value(transaction_id))


def resolve_claim(root_path, transaction_path, root_identity, recover):
    root, control, transaction, transaction_id = open_transaction(
        root_path,
        transaction_path,
        root_identity,
    )
    target = source = None
    try:
        try:
            value = validate_manifest(
                read_manifest(transaction),
                transaction_id,
                root_identity,
            )
        except GenerationMismatchError as error:
            try:
                resolve_metadata_transaction(
                    root,
                    control,
                    transaction,
                    transaction_id,
                    recover,
                )
            except GenerationMismatchError:
                raise error
            return
        expected = manifest_identity(value, "target", full=True)
        target = optional_directory_at(transaction, "target")
        if target is not None:
            metadata = os.fstat(target)
            if identity(metadata) != expected[:2]:
                raise GenerationMismatchError("isolated target generation changed")
            if value["state"] == "isolated" and not matches_generation(metadata, expected):
                raise GenerationMismatchError("isolated target generation changed")
            if value["state"] == "prepared":
                projected = (
                    isolated_value(value, metadata)
                    if recover
                    else {**value, "target": generation_value(metadata)}
                )
            elif value["state"] == "removing":
                projected = removing_value(value, metadata)
            else:
                projected = value
            if recover and projected != value:
                write_manifest(transaction, projected, replace=True)
            print_value(projected)
            return
        if value["state"] == "removing":
            resolve_metadata_transaction(
                root,
                control,
                transaction,
                transaction_id,
                recover,
            )
            return
        source = source_directory(root, value)
        if source is None or identity(os.fstat(source)) != expected[:2]:
            raise GenerationMismatchError("claim has no exact source or isolated target")
        resolve_metadata_transaction(
            root,
            control,
            transaction,
            transaction_id,
            recover,
        )
    finally:
        for descriptor in (source, target, transaction, control, root):
            if descriptor is not None:
                os.close(descriptor)


def load_claim(root_path, transaction_path, root_identity, allowed_states):
    root, control, transaction, transaction_id = open_transaction(
        root_path,
        transaction_path,
        root_identity,
    )
    target = None
    try:
        value = validate_manifest(
            read_manifest(transaction),
            transaction_id,
            root_identity,
        )
        if value["state"] not in allowed_states:
            raise GenerationMismatchError("claim transaction is in the wrong state")
        target = open_directory_at(transaction, "target")
        expected = manifest_identity(value, "target", full=True)
        metadata = os.fstat(target)
        if identity(metadata) != expected[:2]:
            raise GenerationMismatchError("isolated target generation changed")
        if value["state"] == "isolated" and not matches_generation(metadata, expected):
            raise GenerationMismatchError("isolated target generation changed")
        return root, control, transaction, target, transaction_id, value
    except Exception:
        if target is not None:
            os.close(target)
        os.close(transaction)
        os.close(control)
        os.close(root)
        raise


def restore_claim(root_path, transaction_path, root_identity):
    root, control, transaction, target, transaction_id, value = load_claim(
        root_path,
        transaction_path,
        root_identity,
        {"isolated"},
    )
    source_parent = None
    try:
        source_parent, source_name = open_parent(root, value["source"])
        rename_no_replace(transaction, "target", source_parent, source_name)
        if identity(entry_metadata(source_parent, source_name)) != identity(os.fstat(target)):
            raise GenerationMismatchError("restored target generation changed")
        cleanup_transaction(root, control, transaction, transaction_id)
    finally:
        if source_parent is not None:
            os.close(source_parent)
        for descriptor in (target, transaction, control, root):
            os.close(descriptor)


def clear_directory(descriptor):
    # Once the exact target is inside an owner-only transaction, every ordinary
    # child is generated state. Keep identity and mount authority at the
    # transaction/root boundary instead of re-validating each disposable leaf.
    with os.scandir(descriptor) as entries:
        names = [entry.name for entry in entries]
    for name in names:
        metadata = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
        if stat.S_ISDIR(metadata.st_mode):
            child = open_directory_at(descriptor, name)
            try:
                clear_directory(child)
            finally:
                os.close(child)
            os.rmdir(name, dir_fd=descriptor)
        else:
            os.unlink(name, dir_fd=descriptor)
    os.fsync(descriptor)


def remove_claim(root_path, transaction_path, root_identity):
    root, control, transaction, target, transaction_id, value = load_claim(
        root_path,
        transaction_path,
        root_identity,
        {"isolated", "removing"},
    )
    try:
        if value["state"] == "isolated":
            value = removing_value(value, os.fstat(target))
            write_manifest(transaction, value, replace=True)
        clear_directory(target)
        os.rmdir("target", dir_fd=transaction)
        os.fsync(transaction)
        cleanup_transaction(root, control, transaction, transaction_id)
    finally:
        for descriptor in (target, transaction, control, root):
            os.close(descriptor)


def main(argv):
    operation = argv[1] if len(argv) > 1 else "invalid"
    try:
        if not SUPPORTED_PLATFORM:
            raise UnsupportedError(f"unsupported platform: {sys.platform}")
        if len(argv) == 4 and operation == "move":
            rename_no_replace(AT_FDCWD, argv[2], AT_FDCWD, argv[3])
        elif len(argv) == 10 and operation == "claim":
            claim_directory(
                argv[2],
                argv[3],
                argv[4],
                (argv[5], argv[6]),
                (argv[7], argv[8], argv[9]),
            )
        elif len(argv) == 6 and operation in ("inspect", "recover", "restore", "remove"):
            arguments = (argv[2], argv[3], (argv[4], argv[5]))
            if operation == "inspect":
                resolve_claim(*arguments, False)
            elif operation == "recover":
                resolve_claim(*arguments, True)
            elif operation == "restore":
                restore_claim(*arguments)
            else:
                remove_claim(*arguments)
        else:
            raise ValueError("invalid atomic directory operation")
        return 0
    except NativeStatusError as error:
        detail = str(error) or error.__class__.__name__
        print(f"{operation}: {detail}"[:2048], file=sys.stderr)
        return error.exit_code
    except OSError as error:
        number = error.errno if error.errno is not None else -1
        name = errno.errorcode.get(number, "UNKNOWN")
        print(f"{operation}: errno={number} {name}: {error}"[:2048], file=sys.stderr)
        return FAILURE
    except Exception as error:
        print(f"{operation}: {error.__class__.__name__}: {error}"[:2048], file=sys.stderr)
        return FAILURE


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
