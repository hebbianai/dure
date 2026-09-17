#!/usr/bin/env python3
"""Bound and verify cleanup of exact Lima instances owned by one QA run."""

from __future__ import annotations

import os
import pathlib
import re
import signal
import subprocess
import sys
from typing import TextIO


INSTANCE_PATTERN = re.compile(r"hmux-artifact-[A-Za-z0-9.-]+\Z")
CENSUS_NAME_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*\Z")
ACTION_TIMEOUT_SECONDS = 30
LIST_TIMEOUT_SECONDS = 15
_active_child: subprocess.Popen[str] | None = None


class CleanupFailure(RuntimeError):
    pass


def terminate_group(child: subprocess.Popen[str], signal_number: int) -> None:
    try:
        os.killpg(child.pid, signal_number)
    except ProcessLookupError:
        pass


def forward_signal(signal_number: int, _frame: object) -> None:
    if _active_child is not None:
        terminate_group(_active_child, signal_number)
        try:
            _active_child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            terminate_group(_active_child, signal.SIGKILL)
            _active_child.wait()
    raise SystemExit(128 + signal_number)


def bounded_lima(
    arguments: list[str],
    *,
    timeout: int,
    stdout: int | TextIO = subprocess.DEVNULL,
) -> subprocess.CompletedProcess[str]:
    global _active_child
    try:
        child = subprocess.Popen(
            ["limactl", *arguments],
            start_new_session=True,
            stdout=stdout,
            stderr=subprocess.DEVNULL,
            text=True,
        )
    except OSError as error:
        raise CleanupFailure("could not launch pinned limactl") from error
    _active_child = child
    try:
        try:
            output, _ = child.communicate(timeout=timeout)
        except subprocess.TimeoutExpired as error:
            terminate_group(child, signal.SIGTERM)
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                terminate_group(child, signal.SIGKILL)
                child.wait()
            raise CleanupFailure("bounded limactl command timed out") from error
    finally:
        _active_child = None
    return subprocess.CompletedProcess(
        child.args,
        child.returncode,
        output,
        None,
    )


def exact_cleanup(instances: list[str]) -> None:
    if not instances or len(instances) != len(set(instances)):
        raise CleanupFailure("exact cleanup requires distinct instance names")
    if any(INSTANCE_PATTERN.fullmatch(instance) is None for instance in instances):
        raise CleanupFailure("exact cleanup received an unsafe instance name")
    version = bounded_lima(
        ["--version"],
        timeout=LIST_TIMEOUT_SECONDS,
        stdout=subprocess.PIPE,
    )
    if version.returncode != 0 or version.stdout.strip() != "limactl version 1.2.1":
        raise CleanupFailure("exact cleanup did not find pinned limactl")
    for instance in instances:
        for action in ("stop", "delete"):
            bounded_lima(
                [action, "--force", instance],
                timeout=ACTION_TIMEOUT_SECONDS,
            )
    census = bounded_lima(
        ["list", "-q"],
        timeout=LIST_TIMEOUT_SECONDS,
        stdout=subprocess.PIPE,
    )
    if census.returncode != 0:
        raise CleanupFailure("exact Lima census failed")
    observed = set()
    for line in census.stdout.splitlines():
        if CENSUS_NAME_PATTERN.fullmatch(line) is None:
            raise CleanupFailure("exact Lima census returned an unsafe instance name")
        observed.add(line)
    remaining = sorted(observed.intersection(instances))
    if remaining:
        raise CleanupFailure(
            "exact Lima cleanup left owned instances: " + ",".join(remaining)
        )


def main() -> int:
    signal.signal(signal.SIGINT, forward_signal)
    signal.signal(signal.SIGTERM, forward_signal)
    try:
        exact_cleanup(sys.argv[1:])
    except CleanupFailure as error:
        print(f"hmux Linux artifact VM: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
