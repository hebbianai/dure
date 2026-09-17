#!/usr/bin/env python3
"""Fail-closed audit for the pinned upstream TUF conformance result."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

EXPECTED_COLLECTED = 112
EXPECTED_XFAILED = 29


def load_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as source:
        value = json.load(source)
    if not isinstance(value, dict):
        raise ValueError(f"{path.name} must contain a JSON object")
    return value


def load_declarations(path: Path) -> list[str]:
    declarations = [
        line.strip()
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]
    if len(declarations) != len(set(declarations)):
        raise ValueError("xfail declarations must be unique")
    return declarations


def collected_nodeids(report: dict[str, Any]) -> list[str]:
    nodeids: list[str] = []
    for collector in report.get("collectors", []):
        if not isinstance(collector, dict):
            continue
        if collector.get("outcome") != "passed":
            raise ValueError("pytest collection did not pass")
        for result in collector.get("result", []):
            if not isinstance(result, dict) or result.get("type") not in {
                "Function",
                "TestCaseFunction",
            }:
                continue
            nodeid = result.get("nodeid")
            if isinstance(nodeid, str):
                nodeids.append(nodeid)
    if not nodeids:
        raise ValueError("pytest collection found no tests")
    if len(nodeids) != len(set(nodeids)):
        raise ValueError("pytest collection contains duplicate test identities")
    return sorted(nodeids)


def audit_collection(
    report_path: Path, declarations_path: Path, output_path: Path
) -> None:
    report = load_json(report_path)
    declarations = load_declarations(declarations_path)
    nodeids = collected_nodeids(report)
    if len(nodeids) != EXPECTED_COLLECTED:
        raise ValueError(
            f"collected test count must be exactly {EXPECTED_COLLECTED}"
        )
    if len(declarations) != EXPECTED_XFAILED:
        raise ValueError(
            f"xfail declaration count must be exactly {EXPECTED_XFAILED}"
        )
    names = {nodeid: nodeid.rsplit("::", 1)[-1] for nodeid in nodeids}

    expected: list[str] = []
    for declaration in declarations:
        matches = [
            nodeid
            for nodeid, name in names.items()
            if name == declaration or name.split("[", 1)[0] == declaration
        ]
        if len(matches) != 1:
            raise ValueError(
                f"xfail declaration must select exactly one test: {declaration}"
            )
        expected.append(matches[0])

    payload = {
        "collected": len(nodeids),
        "collectedNodeids": nodeids,
        "declaredXfails": len(declarations),
        "expectedXfailedNodeids": sorted(expected),
    }
    output_path.write_text(
        json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )


def audit_result(
    report_path: Path, expected_path: Path, output_path: Path
) -> None:
    report = load_json(report_path)
    expected = load_json(expected_path)
    expected_xfailed = set(expected.get("expectedXfailedNodeids", []))
    expected_nodeids = expected.get("collectedNodeids")
    if (
        not isinstance(expected_nodeids, list)
        or len(expected_nodeids) != EXPECTED_COLLECTED
        or any(not isinstance(nodeid, str) for nodeid in expected_nodeids)
        or len(expected_nodeids) != len(set(expected_nodeids))
    ):
        raise ValueError("collection audit has no exact unique test identity set")
    if (
        expected.get("collected") != EXPECTED_COLLECTED
        or expected.get("declaredXfails") != EXPECTED_XFAILED
        or len(expected_xfailed) != EXPECTED_XFAILED
    ):
        raise ValueError("collection audit differs from the pinned test policy")
    tests = report.get("tests", [])
    if not isinstance(tests, list):
        raise ValueError("pytest report has no test list")

    outcomes: dict[str, int] = {}
    actual_xfailed: set[str] = set()
    actual_nodeids: list[str] = []
    for test in tests:
        if not isinstance(test, dict):
            raise ValueError("pytest report contains an invalid test")
        nodeid = test.get("nodeid")
        outcome = test.get("outcome")
        if not isinstance(nodeid, str) or not isinstance(outcome, str):
            raise ValueError("pytest report test identity is incomplete")
        actual_nodeids.append(nodeid)
        outcomes[outcome] = outcomes.get(outcome, 0) + 1
        if outcome == "xfailed":
            actual_xfailed.add(nodeid)
        elif outcome != "passed":
            raise ValueError(f"unexpected pytest outcome: {outcome}")

    if report.get("exitcode") != 0:
        raise ValueError("pytest exited unsuccessfully")
    if len(actual_nodeids) != len(set(actual_nodeids)):
        raise ValueError("pytest result contains duplicate test identities")
    if set(actual_nodeids) != set(expected_nodeids):
        raise ValueError("executed test identity set differs from collection")
    if actual_xfailed != expected_xfailed:
        raise ValueError("actual expected-failure set differs from declaration")
    if len(tests) != EXPECTED_COLLECTED:
        raise ValueError("executed test count differs from collected test count")

    raw_bytes = report_path.read_bytes()
    payload = {
        "ok": True,
        "collected": len(tests),
        "passed": outcomes.get("passed", 0),
        "xfailed": outcomes.get("xfailed", 0),
        "rawReportSha256": hashlib.sha256(raw_bytes).hexdigest(),
        "rawReportUploaded": False,
    }
    output_path.write_text(
        json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    collect = subparsers.add_parser("collect")
    collect.add_argument("report", type=Path)
    collect.add_argument("xfails", type=Path)
    collect.add_argument("output", type=Path)

    result = subparsers.add_parser("result")
    result.add_argument("report", type=Path)
    result.add_argument("expected", type=Path)
    result.add_argument("output", type=Path)

    args = parser.parse_args()
    if args.command == "collect":
        audit_collection(args.report, args.xfails, args.output)
    else:
        audit_result(args.report, args.expected, args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
