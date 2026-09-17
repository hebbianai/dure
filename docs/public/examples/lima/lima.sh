#!/bin/bash
# Copy this file into your project and reference it from dure.environments.json.
# This recipe uses only Lima instances derived from Dure's preallocated ID.
set -euo pipefail
exec python3 - <<'PY'
import json
import os
from pathlib import Path
import re
import shlex
import socket
import subprocess
import tempfile

instance_id = os.environ["DURE_ENVIRONMENT_ID"]
if not re.fullmatch(r"env-[0-9a-f]{64}", instance_id):
    raise SystemExit("Invalid Dure instance ID")
name = "dure-" + instance_id[4:28]
action = os.environ["DURE_ENVIRONMENT_ACTION"]
lima_home = Path(os.environ.get("LIMA_HOME", str(Path.home() / ".lima"))).expanduser()
log_dir = lima_home.parent / (lima_home.name + "-dure-logs")
log_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
log_path = log_dir / (name + ".log")
log_fd = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
with os.fdopen(log_fd, "ab") as log:
    def run(args, *, capture=False, input=None):
        return subprocess.run(args, check=True, input=input, stdout=subprocess.PIPE if capture else log,
                              stderr=log).stdout

    existing = run(["limactl", "list", "--quiet"], capture=True).decode().splitlines()
    if action == "destroy":
        if name in existing:
            run(["limactl", "delete", "--force", name])
        raise SystemExit(0)
    if action == "suspend":
        run(["limactl", "stop", name])
        raise SystemExit(0)
    if action not in ("create", "resume"):
        raise SystemExit("Unknown lifecycle action")
    if action == "resume" and name not in existing:
        raise SystemExit("Owned VM no longer exists")

    project = Path(os.environ["DURE_PROJECT_PATH"])
    if action == "create" and name not in existing:
        # Pin the loopback port in the VM configuration so resume preserves SSH identity.
        with socket.socket() as port_reservation:
            port_reservation.bind(("127.0.0.1", 0))
            port = port_reservation.getsockname()[1]
        version = run(["limactl", "--version"], capture=True).decode()
        major = int(re.search(r"version (\d+)", version).group(1))
        template = "template://ubuntu-24.04" if major < 2 else "template:ubuntu-24.04"
        run(["limactl", "create", "--tty=false", "--name=" + name,
             "--cpus=2", "--memory=2", "--disk=12", "--mount-none", "--containerd=none",
             "--set=.user.name = \"dure\" | .user.home = \"/home/dure\" | .ssh.localPort = " + str(port),
             template])
    run(["limactl", "start", "--tty=false", name])
    if action == "create":
        # Transfer committed Git history without exposing the host home or credentials.
        with tempfile.TemporaryDirectory(prefix="dure-vm-bundle-") as temporary:
            bundle = Path(temporary) / "project.bundle"
            run(["git", "-C", str(project), "bundle", "create", str(bundle), "HEAD"])
            run(["limactl", "copy", str(bundle), name + ":/tmp/dure-project.bundle"])
            run(["limactl", "shell", name, "--", "bash", "-c",
                 "set -e; if ! command -v git >/dev/null; then sudo apt-get update; sudo apt-get install -y git; fi; "
                 "if [ ! -d /home/dure/project/.git ]; then "
                 "git init /home/dure/project; "
                 "git -C /home/dure/project fetch /tmp/dure-project.bundle HEAD; "
                 "git -C /home/dure/project checkout -B main FETCH_HEAD; fi; "
                 "rm -f /tmp/dure-project.bundle"])
    ssh_config = run(["limactl", "list", "--format={{.SSHConfigFile}}", name], capture=True).decode().strip()
    # Read only the connection fields; Dure retains its normal SSH host-key checks.
    resolved = run(["ssh", "-G", "-F", ssh_config, "lima-" + name], capture=True).decode()
    fields = {}
    for line in resolved.splitlines():
        key, _, value = line.partition(" ")
        fields.setdefault(key, value)
    key_path = shlex.split(fields["identityfile"])[0]
    print(json.dumps({
        "schemaVersion": 1, "resourceId": name,
        "connection": {"host": fields["hostname"], "port": int(fields["port"]),
                       "user": fields["user"], "keyPath": str(Path(key_path).expanduser()),
                       "projectRoot": "/home/dure/project"},
        "userData": {"logPath": str(log_path)}
    }))
PY
