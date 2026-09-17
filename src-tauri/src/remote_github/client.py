#!/usr/bin/env python3
"""The gh installed only on a Dure SSH agent's PATH; credentials stay on desktop."""
import json
import os
import socket
import sys

MAX_RESPONSE = 4 * 1024 * 1024


def main():
    if sys.argv[1:] in ([], ["--help"], ["issue", "--help"]):
        print("Dure desktop GitHub: gh issue list [--json FIELDS] | gh issue view NUMBER [--comments] [--json FIELDS]\nReads this SSH project's repository using the connected desktop's gh login. Writes and authentication commands are unavailable.")
        return 0
    request = json.dumps({"schemaVersion": 1, "args": sys.argv[1:]}, separators=(",", ":")).encode() + b"\n"
    if len(request) > 16384:
        raise ValueError("GitHub request is too large")
    with open(os.path.join(os.path.dirname(os.path.realpath(__file__)), "connection.json"), encoding="utf-8") as stream:
        endpoint = json.load(stream)
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(35)
        connection.connect(endpoint["socket"])
        connection.sendall(request)
        with connection.makefile("rb") as stream:
            line = stream.readline(MAX_RESPONSE + 1)
        if not line.endswith(b"\n") or len(line) > MAX_RESPONSE:
            raise ValueError("GitHub response is incomplete or too large")
    result = json.loads(line)
    sys.stdout.write(result["stdout"])
    sys.stderr.write(result["stderr"])
    return result["code"] if 0 <= result["code"] <= 255 else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, TypeError) as error:
        print("Dure desktop GitHub is unavailable. Reconnect Dure and refresh this SSH agent. " + str(error), file=sys.stderr)
        sys.exit(1)
