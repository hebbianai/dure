"""Behavioral checks of the shipped SSH relay and gh client, without credentials."""
import json
import os
from pathlib import Path
import select
import socket
import subprocess
import sys
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[2] / "src-tauri/src/remote_github"
CLIENT = (SOURCE / "client.py").read_text()
SERVER = "CLIENT_SOURCE = " + repr(CLIENT) + "\n" + (SOURCE / "server.py").read_text()


class BridgeTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.TemporaryDirectory(prefix="dure-github-test-")
        self.directory = Path(self.root.name) / "bridges" / "scope with ' quotes"
        self.repo = Path(self.root.name) / "repo"
        self.repo.mkdir()
        environment = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
        for arguments in (["init", "-q"], ["remote", "add", "origin", "git@github.com:owner/repo.git"]):
            subprocess.run(["git", "-C", str(self.repo), *arguments], env=environment, check=True)
        self.server = subprocess.Popen([sys.executable, "-u", "-c", SERVER, str(self.directory), str(self.repo)],
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertEqual(self.read(), {"origin": "git@github.com:owner/repo.git", "directory": str(self.directory)})
        self.reply({"ready": True})
        self.assertEqual(self.read(), {"listening": True})
        self.clients = []

    def tearDown(self):
        self.server.stdin.close()
        self.server.wait(timeout=5)
        for client in self.clients:
            client.communicate(timeout=5)
        self.server.stdout.close()
        self.server.stderr.close()
        self.root.cleanup()

    def read(self):
        self.assertTrue(select.select([self.server.stdout], [], [], 3)[0], "SSH relay did not respond")
        return json.loads(self.server.stdout.readline())

    def reply(self, value):
        self.server.stdin.write(json.dumps(value).encode() + b"\n")
        self.server.stdin.flush()

    def client(self, *args):
        process = subprocess.Popen([sys.executable, str(self.directory / "gh"), *args],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.clients.append(process)
        return process

    def test_reads_and_comments_preserve_output_and_exit_status(self):
        process = self.client("issue", "view", "42", "--comments", "--json", "body,comments")
        self.assertEqual(self.read(), {"schemaVersion": 1, "args": ["issue", "view", "42", "--comments", "--json", "body,comments"]})
        body = '{"body":"내용", "comments":[{"body":"A comment"}]}\n'
        self.reply({"stdout": body, "stderr": "", "code": 0})
        stdout, stderr = process.communicate(timeout=3)
        self.assertEqual((stdout.decode(), stderr, process.returncode), (body, b"", 0))
        process = self.client("issue", "list")
        self.read()
        self.reply({"stdout": "", "stderr": "Sign in on the desktop with gh auth login.\n", "code": 4})
        stdout, stderr = process.communicate(timeout=3)
        self.assertEqual((stdout, process.returncode), (b"", 4))
        self.assertIn(b"desktop", stderr)

    def test_concurrent_callers_do_not_exchange_responses(self):
        first = self.client("issue", "view", "1")
        request = self.read()
        second = self.client("issue", "view", "2")
        self.reply({"stdout": request["args"][-1], "stderr": "", "code": 0})
        request = self.read()
        self.reply({"stdout": request["args"][-1], "stderr": "", "code": 0})
        self.assertEqual(first.communicate(timeout=3)[0], b"1")
        self.assertEqual(second.communicate(timeout=3)[0], b"2")

    def test_private_files_and_disconnect_remove_only_owned_socket(self):
        endpoint = json.loads((self.directory / "connection.json").read_text())
        for path, mode in [(self.directory, 0o700), (self.directory / "gh", 0o700), (self.directory / "connection.json", 0o600), (Path(endpoint["socket"]), 0o600)]:
            self.assertEqual(path.stat().st_mode & 0o777, mode)
        self.server.stdin.close()
        self.server.wait(timeout=3)
        self.assertFalse(Path(endpoint["socket"]).exists())
        process = self.client("issue", "list")
        stdout, stderr = process.communicate(timeout=3)
        self.assertEqual((stdout, process.returncode), (b"", 1))
        self.assertIn(b"Reconnect Dure", stderr)

    def test_oversized_request_does_not_reach_desktop(self):
        process = self.client("issue", "list", "--search", "x" * 20000)
        _, stderr = process.communicate(timeout=3)
        self.assertEqual(process.returncode, 1)
        self.assertIn(b"too large", stderr)
        self.assertFalse(select.select([self.server.stdout], [], [], 0.1)[0])

    def test_refresh_republishes_endpoint_and_old_owner_cannot_remove_it(self):
        previous = self.server
        old_endpoint = json.loads((self.directory / "connection.json").read_text())
        self.server = subprocess.Popen([sys.executable, "-u", "-c", SERVER, str(self.directory), str(self.repo)],
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            self.read()
            self.reply({"ready": True})
            self.assertEqual(self.read(), {"listening": True})
        finally:
            previous.stdin.close()
            previous.wait(timeout=3)
            previous.stdout.close()
            previous.stderr.close()
        self.assertFalse(Path(old_endpoint["socket"]).exists())
        process = self.client("issue", "view", "8")
        self.assertEqual(self.read()["args"], ["issue", "view", "8"])
        self.reply({"stdout": "refreshed", "stderr": "", "code": 0})
        self.assertEqual(process.communicate(timeout=3)[0], b"refreshed")

    def test_invalid_json_cannot_desynchronize_following_request(self):
        endpoint = json.loads((self.directory / "connection.json").read_text())
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.connect(endpoint["socket"])
            connection.sendall(b"not json\n")
        process = self.client("issue", "view", "7")
        self.assertEqual(self.read()["args"], ["issue", "view", "7"])
        self.reply({"stdout": "seven", "stderr": "", "code": 0})
        self.assertEqual(process.communicate(timeout=3)[0], b"seven")


if __name__ == "__main__":
    unittest.main()
