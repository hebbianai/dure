"""Private Unix socket to the owning desktop's authenticated SSH stdio channel."""
import json
import os
import select
import socket
import stat
import subprocess
import sys
import tempfile

MAX_REQUEST = 16384
MAX_RESPONSE = 4 * 1024 * 1024


def private_directory(path):
    os.makedirs(path, mode=0o700, exist_ok=True)
    metadata = os.lstat(path)
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.getuid():
        raise ValueError("GitHub bridge directory is not an owned directory")
    os.chmod(path, 0o700)


def publish(directory, name, contents, mode):
    descriptor, temporary = tempfile.mkstemp(prefix=".next-", dir=directory)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(contents)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, os.path.join(directory, name))
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def receive():
    line = sys.stdin.buffer.readline(MAX_RESPONSE + 1)
    if not line.endswith(b"\n") or len(line) > MAX_RESPONSE:
        raise EOFError("Desktop GitHub connection ended")
    return line


def serve(directory, cwd, client):
    environment = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    origin = subprocess.run(["git", "-C", cwd, "remote", "get-url", "origin"], env=environment,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5, check=False)
    if origin.returncode != 0:
        print(json.dumps({"unavailable": "no_origin"}), flush=True)
        return
    print(json.dumps({"origin": origin.stdout.decode().strip(), "directory": directory}), flush=True)
    if json.loads(receive()) != {"ready": True}:
        return
    private_directory(os.path.dirname(directory))
    private_directory(directory)
    # Short socket paths also work on macOS hosts (sockaddr_un is only 104 bytes).
    with tempfile.TemporaryDirectory(prefix="dure-gh-", dir="/tmp") as temporary:
        socket_path = os.path.join(temporary, "socket")
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
            listener.bind(socket_path)
            os.chmod(socket_path, 0o600)
            # ponytail: one in-flight read per project, with a queue of eight.
            # Add multiplexed request IDs if parallel issue reads become necessary.
            listener.listen(8)
            publish(directory, "gh", client.encode(), 0o700)
            publish(directory, "connection.json", json.dumps({"socket": socket_path}).encode(), 0o600)
            print('{"listening":true}', flush=True)
            while True:
                readable, _, _ = select.select([listener, sys.stdin], [], [], 10)
                if sys.stdin in readable:
                    # Outside a request only EOF is expected. A foreign frame cannot
                    # become the next caller's response.
                    return
                if not readable:
                    print('{"heartbeat":true}', flush=True)
                    if json.loads(receive()) != {"ready": True}:
                        return
                    continue
                with listener.accept()[0] as connection:
                    connection.settimeout(5)
                    try:
                        with connection.makefile("rb") as stream:
                            request = stream.readline(MAX_REQUEST + 1)
                        if not request.endswith(b"\n") or len(request) > MAX_REQUEST:
                            continue
                        # JSON framing is checked here so embedded newlines cannot
                        # desynchronize the authenticated SSH request stream.
                        value = json.loads(request)
                        print(json.dumps(value, separators=(",", ":")), flush=True)
                        response = receive()
                        connection.sendall(response)
                    except (OSError, ValueError):
                        continue


try:
    serve(sys.argv[1], sys.argv[2], CLIENT_SOURCE)
except (OSError, ValueError, EOFError, subprocess.SubprocessError) as error:
    print("Dure GitHub bridge stopped: " + str(error), file=sys.stderr)
