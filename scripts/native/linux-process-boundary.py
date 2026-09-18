#!/usr/bin/env python3

import ctypes
import errno
import json
import os
import select
import signal
import subprocess
import sys
import time


PR_SET_CHILD_SUBREAPER = 36
PR_GET_CHILD_SUBREAPER = 37


def fail(message, status=5):
    print(message, file=sys.stderr)
    raise SystemExit(status)


def require_linux():
    if not sys.platform.startswith("linux"):
        fail("linux process boundary is unavailable on this platform")


def parse_pid(value):
    try:
        parsed = int(value, 10)
    except ValueError:
        fail("invalid process id", 2)
    if parsed <= 1:
        fail("invalid process id", 2)
    return parsed


def open_proc_directory(pid, allow_inaccessible=False):
    try:
        return os.open(
            f"/proc/{pid}",
            os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC,
        )
    except FileNotFoundError:
        return None
    except ProcessLookupError:
        return None
    except OSError as error:
        if allow_inaccessible and error.errno in (errno.EACCES, errno.EPERM):
            return None
        fail(f"proc directory open failed errno={error.errno}")


def read_proc_text(proc_directory, name, allow_inaccessible=False):
    try:
        descriptor = os.open(
            name,
            os.O_RDONLY | os.O_CLOEXEC,
            dir_fd=proc_directory,
        )
    except FileNotFoundError:
        return None
    except ProcessLookupError:
        return None
    except OSError as error:
        if error.errno in (errno.ENOENT, errno.ESRCH) or (
            allow_inaccessible and error.errno in (errno.EACCES, errno.EPERM)
        ):
            return None
        fail(f"proc {name} read failed errno={error.errno}")
    try:
        with os.fdopen(
            descriptor,
            encoding="utf-8",
            errors="surrogateescape",
        ) as source:
            return source.read()
    except OSError as error:
        if error.errno in (errno.ENOENT, errno.ESRCH) or (
            allow_inaccessible and error.errno in (errno.EACCES, errno.EPERM)
        ):
            return None
        fail(f"proc {name} read failed errno={error.errno}")


def read_proc_stat(proc_directory, allow_inaccessible=False):
    stat = read_proc_text(proc_directory, "stat", allow_inaccessible)
    if stat is None:
        return None
    command_end = stat.rfind(")")
    if command_end < 0:
        fail("malformed proc stat")
    fields = stat[command_end + 2 :].split()
    if len(fields) <= 19 or not fields[19].isdigit():
        fail("malformed proc start time")
    return fields


def read_process_identity_from_directory(
    proc_directory, allow_inaccessible=False
):
    fields = read_proc_stat(proc_directory, allow_inaccessible)
    if fields is None:
        return None
    try:
        return {
            "state": fields[0],
            "parent": int(fields[1], 10),
            "group": int(fields[2], 10),
            "session": int(fields[3], 10),
            "start_ticks": fields[19],
        }
    except ValueError:
        fail("malformed proc identity")


def read_process_identity(pid):
    proc_directory = open_proc_directory(pid)
    if proc_directory is None:
        return None
    try:
        return read_process_identity_from_directory(proc_directory)
    finally:
        os.close(proc_directory)


def read_start_ticks(pid):
    identity = read_process_identity(pid)
    return None if identity is None else identity["start_ticks"]


def read_boot_id():
    try:
        with open(
            "/proc/sys/kernel/random/boot_id", encoding="utf-8"
        ) as source:
            boot_id = source.read().strip()
    except OSError as error:
        fail(f"proc boot id read failed errno={error.errno}")
    if not boot_id or any(character.isspace() for character in boot_id):
        fail("malformed proc boot id")
    return boot_id


def read_boot_time_seconds():
    try:
        with open("/proc/stat", encoding="utf-8") as source:
            matches = [
                line.split()[1]
                for line in source
                if line.startswith("btime ")
            ]
    except OSError as error:
        fail(f"proc boot time read failed errno={error.errno}")
    if len(matches) != 1 or not matches[0].isdigit():
        fail("malformed proc boot time")
    return int(matches[0], 10)


def read_clock_ticks_per_second():
    try:
        value = os.sysconf("SC_CLK_TCK")
    except (OSError, ValueError) as error:
        fail(f"process clock rate read failed: {error}")
    if not isinstance(value, int) or value <= 0:
        fail("invalid process clock rate")
    return value


def emit_process_member(
    pid, identity, boot_id, boot_time_seconds, clock_ticks_per_second, cwd=None
):
    raw_state = identity["state"]
    state = (
        "zombie"
        if raw_state == "Z"
        else "stopped"
        if raw_state in ("T", "t")
        else "live"
    )
    print(
        "M "
        f"{pid} {identity['parent']} {identity['group']} {identity['session']} "
        f"{state} linux:{boot_id}:{identity['start_ticks']} "
        f"{boot_time_seconds + int(identity['start_ticks'], 10) // clock_ticks_per_second}"
        + (f" {cwd}" if cwd is not None else "")
    )


def read_effective_uid(proc_directory, allow_inaccessible=False):
    status = read_proc_text(proc_directory, "status", allow_inaccessible)
    if status is None:
        return None
    for line in status.splitlines():
        if not line.startswith("Uid:"):
            continue
        fields = line.split()
        if len(fields) != 5 or not fields[2].isdigit():
            fail("malformed proc effective uid")
        return int(fields[2], 10)
    fail("malformed proc effective uid")


def read_user_process_identity(pid, closed_enumeration=False):
    allow_inaccessible = not closed_enumeration
    proc_directory = open_proc_directory(pid, allow_inaccessible)
    if proc_directory is None:
        return None
    try:
        before = read_process_identity_from_directory(
            proc_directory, allow_inaccessible
        )
        if before is None:
            return None
        effective_uid = read_effective_uid(
            proc_directory, allow_inaccessible
        )
        if effective_uid is None:
            return None
        after = read_process_identity_from_directory(
            proc_directory, allow_inaccessible
        )
        if after is None:
            return None
        if before["start_ticks"] != after["start_ticks"]:
            if closed_enumeration:
                fail("process identity changed during user census")
            return None
        return after if effective_uid == os.geteuid() else None
    finally:
        os.close(proc_directory)


def observe_points(arguments, include_cwd=False):
    if not arguments:
        fail("missing process ids", 2)
    boot_id = read_boot_id()
    boot_time_seconds = read_boot_time_seconds()
    clock_ticks_per_second = read_clock_ticks_per_second()
    for value in arguments:
        pid = parse_pid(value)
        proc_directory = open_proc_directory(pid)
        if proc_directory is None:
            continue
        try:
            identity = read_process_identity_from_directory(proc_directory)
            if identity is None:
                continue
            cwd = None
            if include_cwd:
                if identity["state"] == "Z":
                    cwd = "-"
                else:
                    try:
                        path = os.readlink("cwd", dir_fd=proc_directory)
                    except OSError as error:
                        after = read_process_identity_from_directory(proc_directory)
                        if after is None:
                            continue
                        if identity["start_ticks"] != after["start_ticks"]:
                            fail("process identity changed during cwd observation")
                        # Exit withdraws cwd before the parent reaps the zombie.
                        # A live process with an unreadable cwd stays unknown.
                        if after["state"] != "Z":
                            fail(f"process cwd unavailable errno={error.errno}")
                        identity = after
                        cwd = "-"
                    else:
                        after = read_process_identity_from_directory(proc_directory)
                        if after is None:
                            continue
                        if identity["start_ticks"] != after["start_ticks"]:
                            fail("process identity changed during cwd observation")
                        if not os.path.isabs(path):
                            fail("process cwd is not absolute")
                        identity = after
                        cwd = os.fsencode(path).hex()
            emit_process_member(
                pid,
                identity,
                boot_id,
                boot_time_seconds,
                clock_ticks_per_second,
                cwd,
            )
        finally:
            os.close(proc_directory)


def observe_group(arguments):
    if len(arguments) != 1:
        fail("usage: observe-group <group-id>", 2)
    group_id = parse_pid(arguments[0])
    boot_id = read_boot_id()
    boot_time_seconds = read_boot_time_seconds()
    clock_ticks_per_second = read_clock_ticks_per_second()
    try:
        entries = os.listdir("/proc")
    except OSError as error:
        fail(f"proc census failed errno={error.errno}")
    for value in entries:
        if not value.isdigit():
            continue
        pid = int(value, 10)
        if pid <= 1:
            continue
        identity = read_process_identity(pid)
        if identity is not None and identity["group"] == group_id:
            emit_process_member(
                pid,
                identity,
                boot_id,
                boot_time_seconds,
                clock_ticks_per_second,
            )


def observe_user_topology(arguments):
    if arguments:
        fail("usage: observe-user-topology", 2)
    boot_id = read_boot_id()
    boot_time_seconds = read_boot_time_seconds()
    clock_ticks_per_second = read_clock_ticks_per_second()
    try:
        entries = os.listdir("/proc")
    except OSError as error:
        fail(f"proc census failed errno={error.errno}")
    for value in entries:
        if not value.isdigit():
            continue
        pid = int(value, 10)
        if pid <= 1 or pid == os.getpid():
            continue
        identity = read_user_process_identity(pid)
        if identity is not None and identity["group"] > 0:
            emit_process_member(
                pid,
                identity,
                boot_id,
                boot_time_seconds,
                clock_ticks_per_second,
            )


def observe_user_census(arguments):
    if len(arguments) not in (0, 3):
        fail("usage: observe-user-census [pid boot-id start-ticks]", 2)
    boot_id = read_boot_id()
    if arguments:
        pid = parse_pid(arguments[0])
        expected_boot, expected_ticks = arguments[1:]
        if not expected_boot or not expected_ticks.isdigit():
            fail("invalid census process precondition", 2)
        identity = read_process_identity(pid)
        if identity is not None and (
            boot_id != expected_boot or identity["start_ticks"] != expected_ticks
        ):
            fail(f"process generation changed pid={pid}", 4)
        # Absence permits the census, never group or root retirement authority.
    boot_time_seconds = read_boot_time_seconds()
    clock_ticks_per_second = read_clock_ticks_per_second()
    try:
        entries = os.listdir("/proc")
    except OSError as error:
        fail(f"proc census failed errno={error.errno}")
    for value in entries:
        if not value.isdigit():
            continue
        pid = int(value, 10)
        if pid <= 1 or pid == os.getpid():
            continue
        identity = read_user_process_identity(pid, closed_enumeration=True)
        if identity is not None and identity["group"] > 0:
            emit_process_member(
                pid,
                identity,
                boot_id,
                boot_time_seconds,
                clock_ticks_per_second,
            )


def require_pidfd_apis():
    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        fail("pidfd signaling is unavailable")


def self_check(arguments):
    if arguments:
        fail("usage: self-check", 2)
    require_pidfd_apis()
    try:
        pidfd = os.pidfd_open(os.getpid(), 0)
    except OSError as error:
        fail(f"pidfd self-check failed errno={error.errno}")
    try:
        signal.pidfd_send_signal(pidfd, 0, None, 0)
    except OSError as error:
        fail(f"pidfd signal self-check failed errno={error.errno}")
    finally:
        os.close(pidfd)


def establish_subreaper():
    require_pidfd_apis()
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
        error = ctypes.get_errno()
        fail(f"PR_SET_CHILD_SUBREAPER failed errno={error}")
    observed = ctypes.c_int(0)
    if libc.prctl(PR_GET_CHILD_SUBREAPER, ctypes.byref(observed), 0, 0, 0) != 0:
        error = ctypes.get_errno()
        fail(f"PR_GET_CHILD_SUBREAPER failed errno={error}")
    if observed.value != 1:
        fail("child subreaper boundary was not established")


def subreaper_exec(arguments):
    if not arguments:
        fail("missing subreaper command", 2)
    establish_subreaper()
    os.environ["DURE_QA_LINUX_SUBREAPER"] = "1"
    os.execvp(arguments[0], arguments)


def read_pipe_with_timeout(file_descriptor, timeout_seconds):
    ready, _, _ = select.select([file_descriptor], [], [], timeout_seconds)
    if not ready:
        fail("stress witness timed out")
    return os.read(file_descriptor, 128)


def wait_for_adoption(pid, expected_parent, timeout_seconds=2.0):
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        identity = read_process_identity(pid)
        if identity is None:
            fail("stress descendant disappeared before containment")
        if identity["parent"] == expected_parent:
            return identity
        time.sleep(0.001)
    fail("stress descendant was not adopted by the subreaper")


def wait_for_child(pid, timeout_seconds=2.0):
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        try:
            observed, status = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            return None
        if observed == pid:
            return status
        time.sleep(0.001)
    fail("stress child did not exit")


def close_file_descriptor(file_descriptor):
    if file_descriptor is None:
        return
    try:
        os.close(file_descriptor)
    except OSError as error:
        if error.errno != errno.EBADF:
            raise


def exact_pidfd_kill(pid, expected_start_ticks):
    require_pidfd_apis()
    try:
        pidfd = os.pidfd_open(pid, 0)
    except ProcessLookupError:
        fail("stress generation disappeared before pidfd open")
    except OSError as error:
        fail(f"stress pidfd_open failed errno={error.errno}")
    try:
        observed = read_start_ticks(pid)
        if observed != expected_start_ticks:
            fail("stress process generation changed before signal")
        try:
            signal.pidfd_send_signal(pidfd, signal.SIGKILL, None, 0)
        except ProcessLookupError:
            fail("stress generation disappeared before signal")
        except OSError as error:
            fail(f"stress pidfd_send_signal failed errno={error.errno}")
    finally:
        os.close(pidfd)


def cleanup_stress_child(pid):
    if pid is None:
        return
    identity = read_process_identity(pid)
    if identity is not None and identity["state"] != "Z":
        exact_pidfd_kill(pid, identity["start_ticks"])
    wait_for_child(pid)


def stress_containment(arguments):
    if len(arguments) != 1:
        fail("usage: stress <iterations>", 2)
    try:
        iterations = int(arguments[0], 10)
    except ValueError:
        fail("invalid stress iteration count", 2)
    if iterations < 1 or iterations > 10_000:
        fail("stress iteration count must be from 1 through 10000", 2)

    establish_subreaper()
    sentinel_read, sentinel_write = os.pipe()
    sentinel_pid = os.fork()
    if sentinel_pid == 0:
        try:
            os.close(sentinel_write)
            while os.read(sentinel_read, 1):
                pass
        finally:
            os._exit(0)
    os.close(sentinel_read)
    sentinel_start = None
    sentinel_deadline = time.monotonic() + 2.0
    while sentinel_start is None and time.monotonic() < sentinel_deadline:
        sentinel_start = read_start_ticks(sentinel_pid)
        if sentinel_start is None:
            time.sleep(0.001)
    if sentinel_start is None:
        os.close(sentinel_write)
        wait_for_child(sentinel_pid)
        fail("stress sentinel has no exact generation")

    completed = 0
    try:
        wrong_generation = subprocess.run(
            [
                sys.executable,
                os.path.realpath(__file__),
                "signal",
                str(sentinel_pid),
                str(int(sentinel_start, 10) + 1),
                str(signal.SIGKILL),
            ],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
        if wrong_generation.returncode != 4:
            fail("stress PID reuse probe did not fail closed")
        if read_start_ticks(sentinel_pid) != sentinel_start:
            fail("stress PID reuse probe signaled the unrelated sentinel")

        for _ in range(iterations):
            report_read, report_write = os.pipe()
            witness_read, witness_write = os.pipe()
            launcher_pid = None
            descendant_pid = None
            try:
                launcher_pid = os.fork()
                if launcher_pid == 0:
                    try:
                        os.close(report_read)
                        os.close(witness_read)
                        child_pid = os.fork()
                        if child_pid == 0:
                            os.setsid()
                            os.write(report_write, f"{os.getpid()}\n".encode())
                            os.close(report_write)
                            os.close(witness_write)
                            while True:
                                signal.pause()
                        os.close(report_write)
                        os.close(witness_write)
                    finally:
                        os._exit(0)

                close_file_descriptor(report_write)
                report_write = None
                close_file_descriptor(witness_write)
                witness_write = None
                report = read_pipe_with_timeout(report_read, 2.0)
                close_file_descriptor(report_read)
                report_read = None
                try:
                    descendant_pid = parse_pid(report.decode().strip())
                except UnicodeDecodeError:
                    fail("stress descendant identity was malformed")
                wait_for_child(launcher_pid)
                launcher_pid = None
                identity = wait_for_adoption(descendant_pid, os.getpid())
                if (
                    identity["group"] != descendant_pid
                    or identity["session"] != descendant_pid
                ):
                    fail("stress descendant did not preserve its setsid boundary")
                if read_pipe_with_timeout(witness_read, 2.0) != b"":
                    fail("stress descendant retained the liveness witness")
                close_file_descriptor(witness_read)
                witness_read = None
                exact_pidfd_kill(descendant_pid, identity["start_ticks"])
                wait_for_child(descendant_pid)
                descendant_pid = None
                if read_start_ticks(sentinel_pid) != sentinel_start:
                    fail("stress cleanup signaled the unrelated sentinel")
                completed += 1
            finally:
                close_file_descriptor(report_read)
                close_file_descriptor(report_write)
                close_file_descriptor(witness_read)
                close_file_descriptor(witness_write)
                cleanup_stress_child(descendant_pid)
                cleanup_stress_child(launcher_pid)
    finally:
        os.close(sentinel_write)
        wait_for_child(sentinel_pid)

    print(
        json.dumps(
            {
                "escapedDescendants": 0,
                "iterations": completed,
                "pidReuseRefused": True,
                "schema": "dure-linux-process-boundary-stress/v1",
                "sentinelSignals": 0,
                "signalAuthority": "pidfd-plus-start-ticks",
                "subreaper": True,
            },
            sort_keys=True,
            separators=(",", ":"),
        )
    )


def signal_generation(arguments):
    if len(arguments) != 3:
        fail("usage: signal <pid> <start-ticks> <signal>", 2)
    pid = parse_pid(arguments[0])
    expected_start_ticks = arguments[1]
    if not expected_start_ticks.isdigit():
        fail("invalid process start ticks", 2)
    try:
        signal_number = int(arguments[2], 10)
    except ValueError:
        fail("invalid signal", 2)
    if signal_number <= 0:
        fail("invalid signal", 2)
    require_pidfd_apis()
    try:
        pidfd = os.pidfd_open(pid, 0)
    except ProcessLookupError:
        raise SystemExit(3)
    except OSError as error:
        if error.errno == errno.ESRCH:
            raise SystemExit(3)
        fail(f"pidfd_open failed errno={error.errno}")
    try:
        observed_start_ticks = read_start_ticks(pid)
        if observed_start_ticks is None:
            raise SystemExit(3)
        if observed_start_ticks != expected_start_ticks:
            raise SystemExit(4)
        try:
            signal.pidfd_send_signal(pidfd, signal_number, None, 0)
        except ProcessLookupError:
            raise SystemExit(3)
        except OSError as error:
            if error.errno == errno.ESRCH:
                raise SystemExit(3)
            fail(f"pidfd_send_signal failed errno={error.errno}")
    finally:
        os.close(pidfd)


def signal_identity(arguments):
    if len(arguments) != 4:
        fail("usage: signal-identity <pid> <boot-id> <start-ticks> <signal>", 2)
    expected_boot_id = arguments[1]
    if read_boot_id() != expected_boot_id:
        raise SystemExit(4)
    signal_generation([arguments[0], arguments[2], arguments[3]])


def exec_gate(arguments):
    if not arguments:
        fail("missing gated command", 2)
    try:
        admitted = os.read(0, 1)
    except OSError as error:
        fail(f"command gate read failed errno={error.errno}")
    if admitted != b"G":
        fail("command gate closed before admission")
    os.dup2(4, 0)
    os.close(4)
    os.execvp(arguments[0], arguments)


def main():
    require_linux()
    if len(sys.argv) < 2:
        fail(
            "expected exec-gate, observe-group, observe-point, "
            "observe-user-census, observe-user-topology, signal, "
            "self-check, stress, or subreaper-exec",
            2,
        )
    operation = sys.argv[1]
    arguments = sys.argv[2:]
    if operation == "subreaper-exec":
        subreaper_exec(arguments)
        return
    if operation == "signal":
        signal_generation(arguments)
        return
    if operation == "signal-identity":
        signal_identity(arguments)
        return
    if operation == "self-check":
        self_check(arguments)
        return
    if operation == "observe-point":
        observe_points(arguments)
        return
    if operation == "observe-point-cwd":
        observe_points(arguments, include_cwd=True)
        return
    if operation == "observe-group":
        observe_group(arguments)
        return
    if operation == "observe-user-topology":
        observe_user_topology(arguments)
        return
    if operation == "observe-user-census":
        observe_user_census(arguments)
        return
    if operation == "stress":
        stress_containment(arguments)
        return
    if operation == "exec-gate":
        exec_gate(arguments)
        return
    fail(
        "expected exec-gate, observe-group, observe-point, "
        "observe-user-census, observe-user-topology, signal, "
        "self-check, stress, or subreaper-exec",
        2,
    )


if __name__ == "__main__":
    main()
