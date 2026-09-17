"""Transfer one account-wide build lock to a finite command, without a daemon."""

import errno
import fcntl
import os
import stat
import sys


def require_private(metadata, kind):
    if metadata.st_uid != os.getuid() or metadata.st_mode & 0o077:
        raise ValueError(f"native build slot {kind} must be owner-only")


def acquire(root):
    if not os.path.isabs(root):
        raise ValueError("native build slot root must be absolute")
    os.makedirs(root, mode=0o700, exist_ok=True)
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    descriptor = None
    try:
        directory_metadata = os.fstat(directory)
        require_private(directory_metadata, "directory")
        flags = os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK
        try:
            # Elect one creator. Concurrent nonexclusive O_CREAT calls can
            # fail with ENOENT on macOS even though the directory still exists.
            descriptor = os.open(
                "build.lock", flags | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=directory
            )
        except FileExistsError:
            descriptor = os.open("build.lock", flags, dir_fd=directory)
        metadata = os.fstat(descriptor)
        require_private(metadata, "file")
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            raise ValueError("native build slot must be a regular file with one link")
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            if error.errno not in (errno.EAGAIN, errno.EACCES):
                raise
            print(
                "Waiting for the native build slot; running builds are not interrupted.",
                file=sys.stderr,
                flush=True,
            )
            fcntl.flock(descriptor, fcntl.LOCK_EX)
            print("Native build slot acquired.", file=sys.stderr, flush=True)
        current = os.stat("build.lock", dir_fd=directory, follow_symlinks=False)
        current_directory = os.stat(root, follow_symlinks=False)
        if (
            (current.st_dev, current.st_ino) != (metadata.st_dev, metadata.st_ino)
            or (current_directory.st_dev, current_directory.st_ino)
            != (directory_metadata.st_dev, directory_metadata.st_ino)
        ):
            raise ValueError("native build slot identity changed while waiting")
        # Keep the same inode forever. Unlinking it would let new callers lock
        # another file while existing waiters still refer to this one.
        os.set_inheritable(descriptor, True)
        return descriptor
    except BaseException:
        if descriptor is not None:
            os.close(descriptor)
        raise
    finally:
        os.close(directory)


def main(arguments):
    if len(arguments) < 3 or arguments[1] != "--":
        raise ValueError("usage: native-build-slot.py <root> -- <command> [args...]")
    descriptor = acquire(arguments[0])
    try:
        # exec retains the lock in the actual command. A dead Node launcher
        # cannot release admission while its compiler is still running.
        os.execvpe(arguments[2], arguments[2:], os.environ)
    finally:
        os.close(descriptor)


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except KeyboardInterrupt:
        print("Native build cancelled.", file=sys.stderr)
        sys.exit(130)
    except (OSError, ValueError) as error:
        print(f"Native build was not started: {error}", file=sys.stderr)
        sys.exit(1)
