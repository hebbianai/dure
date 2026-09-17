import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { execFileSync } from "node:child_process";

const root = fs.realpathSync(process.env.DURE_QA_STATE_ROOT);
const home = fs.realpathSync(process.env.HOME);
const runId = process.env.VITE_DURE_SSH_REGISTRATION_QA_RUN_ID;
if (
	home !== path.join(root, "home") ||
	!path.basename(root).startsWith("dure-ssh-registration.") ||
	!/^[a-f0-9-]{36}$/.test(runId ?? "")
)
	throw new Error("SSH QA setup escaped isolation");
const write = (file, text, mode = 0o600) =>
	fs.writeFileSync(file, text, { flag: "wx", mode });
const quote = (text) => `'${text.replaceAll("'", `'"'"'`)}'`;
const ssh = path.join(home, ".ssh");
const remote = path.join(root, "remote-home");
const remoteDiscovery = path.join(root, "remote-discovery");
for (const directory of [
	ssh,
	remote,
	remoteDiscovery,
	path.join(remote, ".local/bin"),
	path.join(root, "sshd-owner"),
])
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
for (const file of [path.join(ssh, "id_ed25519"), path.join(root, "host-key")])
	execFileSync(
		"/usr/bin/ssh-keygen",
		["-q", "-t", "ed25519", "-N", "", "-f", file],
		{ stdio: "pipe", timeout: 5_000 },
	);
const reservation = net.createServer();
await new Promise((resolve, reject) => {
	reservation.once("error", reject);
	reservation.listen(0, "127.0.0.1", resolve);
});
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
write(path.join(ssh, "config"), "");
write(
	path.join(ssh, "known_hosts"),
	`[127.0.0.1]:${port} ${fs.readFileSync(path.join(root, "host-key.pub"), "utf8")}`,
);
write(
	path.join(root, "authorized_keys"),
	fs.readFileSync(path.join(ssh, "id_ed25519.pub")),
);
// Force the disposable home and discovery boundary before interpreting any SSH exec.
const gateway = path.join(root, "gateway.sh");
const gatewayFixture = path.resolve("scripts/qa/ssh-registration-gateway.mjs");
write(
	gateway,
	`#!/bin/sh\nset -eu\ncd ${quote(remote)}\nexec env -u DURE_HOME -u DURE_APP_CHANNEL HOME=${quote(remote)} HMUX_DISCOVERY_ROOT=${quote(remoteDiscovery)} HMUX_RUNTIME=${quote(process.env.DURE_HMUX_RUNTIME_BIN)} /bin/sh -c "$SSH_ORIGINAL_COMMAND"\n`,
	0o700,
);
write(
	path.join(remote, ".local/bin/hmux"),
	`#!/bin/sh\nif [ "$1" = mobile-gateway ]; then\n shift\n exec ${quote(process.execPath)} ${quote(gatewayFixture)} ${quote(root)} ${quote(process.env.DURE_HMUX_BIN)} --discovery-root ${quote(remoteDiscovery)} mobile-gateway --allow-create "$@"\nfi\nexec ${quote(process.env.DURE_HMUX_BIN)} --discovery-root ${quote(remoteDiscovery)} "$@"\n`,
	0o700,
);
write(
	path.join(root, "sshd.conf"),
	`HostKey ${root}/host-key\nPidFile ${root}/sshd.pid\nListenAddress 127.0.0.1\nPort ${port}\nAuthorizedKeysFile ${root}/authorized_keys\nStrictModes yes\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nAllowTcpForwarding no\nPermitTTY no\nForceCommand ${gateway}\nPrintMotd no\nLogLevel ERROR\n`,
);
write(
	path.join(root, "qa.autorun"),
	JSON.stringify({
		runId,
		home: process.env.HOME,
		host: "127.0.0.1",
		port,
		user: os.userInfo().username,
	}),
);
