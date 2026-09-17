import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import { spawn as spawnProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { fixtureClaudeExecutableIdentity } from "../../tests/fixtures/claude-executable-identity.mjs";
import {
	RelayFrameDecoder,
	RelayFrameKind,
	encodeRelayFrame,
} from "./process-relay-protocol.mjs";
import { createClaudeRelaySpawner } from "./relay-spawned-process.mjs";

const identity = Object.freeze({
	runtimeGeneration: "runtime-test-1",
	queryEpoch: "query-test-1",
	relayId: "relay-test-1",
});
const relayBinary = process.env.DURE_CLAUDE_PROCESS_RELAY_BIN;
const fixtureDirectory = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../tests/fixtures",
);
const fakeClaude = path.join(fixtureDirectory, "fake-claude-relay-child.mjs");
const nodeExecutableIdentity = fixtureClaudeExecutableIdentity(process.execPath);

async function waitForPath(target, label) {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (fs.existsSync(target)) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`${label}_never_appeared`);
}

async function waitForProcessAbsence(processId) {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		try {
			process.kill(processId, 0);
		} catch (error) {
			if (error?.code === "ESRCH") return;
			throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("fake_claude_survived_relay_exit");
}

async function withNativeRelay(run, expectedExitCode = 0) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-claude-native-relay-"));
	fs.chmodSync(root, 0o700);
	const endpoint = path.join(root, "relay.sock");
	const capabilityFile = path.join(root, "capability");
	const launchCapability = `native-capability-${process.pid}-${Date.now()}`;
	fs.writeFileSync(capabilityFile, launchCapability, { mode: 0o600 });
	const relay = spawnProcess(
		relayBinary,
		[
			"--endpoint",
			endpoint,
			"--capability-file",
			capabilityFile,
			"--runtime-generation",
			identity.runtimeGeneration,
			"--query-epoch",
			identity.queryEpoch,
			"--relay-id",
			identity.relayId,
		],
		{ env: process.env, shell: false, stdio: ["ignore", "ignore", "pipe"] },
	);
	let relayStderr = "";
	relay.stderr.setEncoding("utf8");
	relay.stderr.on("data", (chunk) => {
		relayStderr += chunk;
	});
	const relayExit = once(relay, "exit");
	try {
		await waitForPath(endpoint, "relay_socket");
		await run({ endpoint, launchCapability, root });
		const [code, signal] = await relayExit;
		assert.equal(code, expectedExitCode, relayStderr);
		assert.equal(signal, null);
		assert.equal(relayStderr.includes(launchCapability), false);
	} finally {
		if (relay.exitCode === null && relay.signalCode === null) relay.kill("SIGTERM");
		if (relay.exitCode === null && relay.signalCode === null) await relayExit;
		fs.rmSync(root, { recursive: true, force: true });
	}
}

function nativeSpawn(endpoint, launchCapability, stateDirectory, options = {}) {
	const abortController = options.abortController ?? new AbortController();
	const diagnostics = [];
	const spawn = createClaudeRelaySpawner({
		endpoint,
		identity: options.identity ?? identity,
		launchCapability,
		onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
	});
	const child = spawn({
		command: process.execPath,
		commandIdentity: options.commandIdentity ?? nodeExecutableIdentity,
		args: [
			fakeClaude,
			"--state-dir",
			stateDirectory,
			"--mode",
			options.mode ?? "echo",
			"--exit-code",
			String(options.exitCode ?? 0),
		],
		cwd: process.cwd(),
		env: { ...process.env },
		signal: abortController.signal,
	});
	child.stdin.on("error", () => {});
	child.stdout.on("error", () => {});
	return { abortController, child, diagnostics };
}

function createEchoServer() {
	return net.createServer((socket) => {
		const decoder = new RelayFrameDecoder();
		let relaySequence = 1;
		let stdoutSequence;
		socket.on("data", (chunk) => {
			for (const frame of decoder.push(chunk)) {
				if (frame.kind === RelayFrameKind.hello) {
					socket.write(
						encodeRelayFrame({
							kind: RelayFrameKind.ready,
							sequence: relaySequence++,
							identity,
							metadata: { helloSequence: frame.sequence, pid: process.pid },
						}),
					);
				} else if (frame.kind === RelayFrameKind.stdin) {
					stdoutSequence = relaySequence;
					socket.write(
						encodeRelayFrame({
							kind: RelayFrameKind.stdinAck,
							sequence: relaySequence++,
							identity,
							metadata: { ackSequence: frame.sequence },
						}),
					);
					socket.write(
						encodeRelayFrame({
							kind: RelayFrameKind.stdout,
							sequence: relaySequence++,
							identity,
							payload: frame.payload,
						}),
					);
				} else if (
					frame.kind === RelayFrameKind.stdoutAck &&
					frame.metadata.ackSequence === stdoutSequence
				) {
					stdoutSequence = undefined;
				} else if (frame.kind === RelayFrameKind.stdinEof) {
					socket.write(
						encodeRelayFrame({
							kind: RelayFrameKind.stdinEofAck,
							sequence: relaySequence++,
							identity,
							metadata: { ackSequence: frame.sequence },
						}),
					);
					socket.write(
						encodeRelayFrame({
							kind: RelayFrameKind.stdoutEof,
							sequence: relaySequence++,
							identity,
						}),
					);
					socket.end(
						encodeRelayFrame({
							kind: RelayFrameKind.exit,
							sequence: relaySequence++,
							identity,
							metadata: { code: 0, signal: null, stderrTruncated: false },
						}),
					);
				}
			}
		});
	});
}

async function withEchoRelay(run) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-claude-relay-node-"));
	fs.chmodSync(root, 0o700);
	const endpoint = path.join(root, "relay.sock");
	const server = createEchoServer();
	server.listen(endpoint);
	await once(server, "listening");
	fs.chmodSync(endpoint, 0o600);
	try {
		await run(endpoint);
	} finally {
		server.close();
		await once(server, "close");
		fs.rmSync(root, { recursive: true, force: true });
	}
}

function delay(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test("relay codec reassembles fragmented binary frames with authoritative identity", () => {
	const encoded = encodeRelayFrame({
		kind: RelayFrameKind.stdout,
		sequence: 7,
		identity,
		metadata: { runtimeGeneration: "stale-runtime" },
		payload: Buffer.from([0, 1, 2, 255]),
	});
	const decoder = new RelayFrameDecoder();
	const frames = [];
	for (let offset = 0; offset < encoded.length; offset += 3) {
		frames.push(...decoder.push(encoded.subarray(offset, offset + 3)));
	}
	decoder.finish();
	assert.equal(frames.length, 1);
	assert.equal(frames[0].sequence, 7);
	assert.deepEqual(frames[0].identity, identity);
	assert.deepEqual(frames[0].payload, Buffer.from([0, 1, 2, 255]));
});

test("connection waits for a relay endpoint that binds after spawn", { timeout: 5_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-claude-relay-node-"));
	fs.chmodSync(root, 0o700);
	const endpoint = path.join(root, "relay.sock");
	const server = createEchoServer();
	try {
		// The relay binds its endpoint only after its hmux session boots; the
		// spawner must wait out that boot instead of failing on the missing
		// socket (the pre-fix behavior).
		const spawn = createClaudeRelaySpawner({
			endpoint,
			identity,
			launchCapability: "capability-test-0123456789",
		});
		const child = spawn({
			command: process.execPath,
			commandIdentity: nodeExecutableIdentity,
			args: ["fake-claude"],
			cwd: process.cwd(),
			env: { DURE_RELAY_TEST: "1" },
			signal: new AbortController().signal,
		});
		child.on("error", () => {});
		await delay(300);
		server.listen(endpoint);
		await once(server, "listening");
		fs.chmodSync(endpoint, 0o600);

		const output = Promise.race([
			once(child.stdout, "data"),
			once(child.stdin, "error").then(([error]) => Promise.reject(error)),
		]);
		child.stdin.write(Buffer.from("late-endpoint-probe"));
		const [bytes] = await output;
		assert.equal(bytes.toString("utf8"), "late-endpoint-probe");
		const exited = once(child, "exit");
		child.stdin.end();
		assert.deepEqual(await exited, [0, null]);
	} finally {
		server.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("connection waits for relay endpoint permission publication", { timeout: 5_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-claude-relay-mode-"));
	fs.chmodSync(root, 0o700);
	const endpoint = path.join(root, "relay.sock");
	const server = createEchoServer();
	server.listen(endpoint);
	await once(server, "listening");
	fs.chmodSync(endpoint, 0o660);
	try {
		const spawn = createClaudeRelaySpawner({
			endpoint,
			identity,
			launchCapability: "capability-mode-0123456789",
		});
		const child = spawn({
			command: process.execPath,
			commandIdentity: nodeExecutableIdentity,
			args: ["fake-claude"],
			cwd: process.cwd(),
			env: { DURE_RELAY_TEST: "1" },
			signal: new AbortController().signal,
		});
		child.on("error", () => {});
		await delay(100);
		fs.chmodSync(endpoint, 0o600);

		const output = Promise.race([
			once(child.stdout, "data"),
			once(child.stdin, "error").then(([error]) => Promise.reject(error)),
		]);
		child.stdin.write(Buffer.from("permission-publication-probe"));
		const [bytes] = await output;
		assert.equal(bytes.toString("utf8"), "permission-publication-probe");
		const exited = once(child, "exit");
		child.stdin.end();
		assert.deepEqual(await exited, [0, null]);
	} finally {
		server.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("virtual SpawnedProcess handshakes and preserves one stdin/stdout byte sequence", { timeout: 2_000 }, async () => {
	await withEchoRelay(async (endpoint) => {
		const spawn = createClaudeRelaySpawner({
			endpoint,
			identity,
			launchCapability: "capability-test-0123456789",
		});
		const child = spawn({
			command: process.execPath,
			commandIdentity: nodeExecutableIdentity,
			args: ["fake-claude"],
			cwd: process.cwd(),
			env: { DURE_RELAY_TEST: "1" },
			signal: new AbortController().signal,
		});
		child.on("error", () => {});

		const output = Promise.race([
			once(child.stdout, "data"),
			once(child.stdin, "error").then(([error]) => Promise.reject(error)),
		]);
		child.stdin.write(Buffer.from("ordered-probe"));
		const [bytes] = await output;
		assert.equal(bytes.toString("utf8"), "ordered-probe");
		const exited = once(child, "exit");
		child.stdin.end();
		assert.deepEqual(await exited, [0, null]);
	});
});

test(
	"virtual SpawnedProcess releases stdin and stdout only across matching credits",
	{ timeout: 2_000 },
	async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-claude-relay-credit-"));
		fs.chmodSync(root, 0o700);
		const endpoint = path.join(root, "relay.sock");
		let peer;
		let relaySequence = 1;
		let resolveReady;
		let resolveStdin;
		let resolveStdoutAck;
		let resolveStdinEof;
		const ready = new Promise((resolve) => {
			resolveReady = resolve;
		});
		const stdinFrame = new Promise((resolve) => {
			resolveStdin = resolve;
		});
		const stdoutAck = new Promise((resolve) => {
			resolveStdoutAck = resolve;
		});
		const stdinEof = new Promise((resolve) => {
			resolveStdinEof = resolve;
		});
		const server = net.createServer((socket) => {
			peer = socket;
			const decoder = new RelayFrameDecoder();
			socket.on("data", (chunk) => {
				for (const frame of decoder.push(chunk)) {
					if (frame.kind === RelayFrameKind.hello) {
						socket.write(
							encodeRelayFrame({
								kind: RelayFrameKind.ready,
								sequence: relaySequence++,
								identity,
								metadata: { helloSequence: frame.sequence, pid: process.pid },
							}),
						);
						resolveReady();
					} else if (frame.kind === RelayFrameKind.stdin) {
						resolveStdin(frame);
					} else if (frame.kind === RelayFrameKind.stdoutAck) {
						resolveStdoutAck(frame);
					} else if (frame.kind === RelayFrameKind.stdinEof) {
						resolveStdinEof(frame);
					}
				}
			});
		});
		server.listen(endpoint);
		await once(server, "listening");
		fs.chmodSync(endpoint, 0o600);
		try {
			const spawn = createClaudeRelaySpawner({
				endpoint,
				identity,
				launchCapability: "credit-capability-0123456789",
			});
			const child = spawn({
				command: process.execPath,
				commandIdentity: nodeExecutableIdentity,
				args: ["fake-claude"],
				cwd: process.cwd(),
				env: { DURE_RELAY_TEST: "1" },
				signal: new AbortController().signal,
			});
			child.on("error", () => {});
			child.stdin.on("error", () => {});
			await ready;

			let writeCompleted = false;
			child.stdin.write(Buffer.from("held-input"), () => {
				writeCompleted = true;
			});
			const heldStdin = await stdinFrame;
			await delay(20);
			assert.equal(writeCompleted, false);
			peer.write(
				encodeRelayFrame({
					kind: RelayFrameKind.stdinAck,
					sequence: relaySequence++,
					identity,
					metadata: { ackSequence: heldStdin.sequence },
				}),
			);
			while (!writeCompleted) await delay(1);

			const stdoutSequence = relaySequence;
			peer.write(
				encodeRelayFrame({
					kind: RelayFrameKind.stdout,
					sequence: relaySequence++,
					identity,
					payload: Buffer.alloc(64 * 1024, 0x62),
				}),
			);
			let stdoutWasAcknowledged = false;
			stdoutAck.then(() => {
				stdoutWasAcknowledged = true;
			});
			await delay(20);
			assert.equal(stdoutWasAcknowledged, false);
			let output = child.stdout.read(64 * 1024);
			if (!output) {
				await once(child.stdout, "readable");
				output = child.stdout.read(64 * 1024);
			}
			assert.ok(output);
			assert.equal(output.length, 64 * 1024);
			const heldStdoutAck = await stdoutAck;
			assert.equal(heldStdoutAck.metadata.ackSequence, stdoutSequence);

			const exited = once(child, "exit");
			child.stdin.end();
			const eof = await stdinEof;
			peer.write(
				encodeRelayFrame({
					kind: RelayFrameKind.stdinEofAck,
					sequence: relaySequence++,
					identity,
					metadata: { ackSequence: eof.sequence },
				}),
			);
			peer.write(
				encodeRelayFrame({
					kind: RelayFrameKind.stdoutEof,
					sequence: relaySequence++,
					identity,
				}),
			);
			peer.end(
				encodeRelayFrame({
					kind: RelayFrameKind.exit,
					sequence: relaySequence++,
					identity,
					metadata: { code: 0, signal: null, stderrTruncated: false },
				}),
			);
			assert.deepEqual(await exited, [0, null]);
		} finally {
			peer?.destroy();
			server.close();
			await once(server, "close");
			fs.rmSync(root, { recursive: true, force: true });
		}
	},
);

test(
	"virtual process exit settles an unacknowledged stdin write",
	{ timeout: 2_000 },
	async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-claude-relay-early-exit-"));
		fs.chmodSync(root, 0o700);
		const endpoint = path.join(root, "relay.sock");
		let peer;
		let relaySequence = 1;
		const server = net.createServer((socket) => {
			peer = socket;
			const decoder = new RelayFrameDecoder();
			socket.on("data", (chunk) => {
				for (const frame of decoder.push(chunk)) {
					if (frame.kind === RelayFrameKind.hello) {
						socket.write(
							encodeRelayFrame({
								kind: RelayFrameKind.ready,
								sequence: relaySequence++,
								identity,
								metadata: { helloSequence: frame.sequence, pid: process.pid },
							}),
						);
					} else if (frame.kind === RelayFrameKind.stdin) {
						socket.end(
							Buffer.concat([
								encodeRelayFrame({
									kind: RelayFrameKind.stdoutEof,
									sequence: relaySequence++,
									identity,
								}),
								encodeRelayFrame({
									kind: RelayFrameKind.exit,
									sequence: relaySequence++,
									identity,
									metadata: { code: 0, signal: null, stderrTruncated: false },
								}),
							]),
						);
					}
				}
			});
		});
		server.listen(endpoint);
		await once(server, "listening");
		fs.chmodSync(endpoint, 0o600);
		try {
			const spawn = createClaudeRelaySpawner({
				endpoint,
				identity,
				launchCapability: "early-exit-capability-0123456789",
			});
			const child = spawn({
				command: process.execPath,
				commandIdentity: nodeExecutableIdentity,
				args: ["fake-claude"],
				cwd: process.cwd(),
				env: { DURE_RELAY_TEST: "1" },
				signal: new AbortController().signal,
			});
			child.on("error", () => {});
			child.stdin.on("error", () => {});
			const exited = once(child, "exit");
			const writeResult = new Promise((resolve) => {
				child.stdin.write(Buffer.from("pending-input"), (error) => resolve(error ?? null));
			});
			assert.deepEqual(await exited, [0, null]);
			const result = await Promise.race([
				writeResult,
				delay(50).then(() => "write-remained-pending"),
			]);
			assert.ok(result instanceof Error, String(result));
		} finally {
			peer?.destroy();
			server.close();
			await once(server, "close");
			fs.rmSync(root, { recursive: true, force: true });
		}
	},
);

test(
	"native relay preserves chunked bytes, EOF, bounded stderr, and nonzero exit",
	{ skip: !relayBinary, timeout: 10_000 },
	async () => {
		await withNativeRelay(async ({ endpoint, launchCapability, root }) => {
			const stateDirectory = path.join(root, "child-state");
			fs.mkdirSync(stateDirectory, { mode: 0o700 });
			const { child, diagnostics } = nativeSpawn(
				endpoint,
				launchCapability,
				stateDirectory,
				{ exitCode: 23 },
			);
			const input = Buffer.concat([
				Buffer.from("prefix-"),
				Buffer.alloc(150_000, 0x61),
				Buffer.from("-suffix"),
			]);
			const output = [];
			child.stdout.on("data", (chunk) => output.push(chunk));
			const exited = once(child, "exit");
			child.stdin.end(input);
			assert.deepEqual(await exited, [23, null]);
			assert.deepEqual(Buffer.concat(output), input);
			assert.equal(child.exitCode, 23);
			assert.equal(child.signalCode, null);
			assert.equal(diagnostics.length, 1);
			assert.equal(Buffer.byteLength(diagnostics[0].stderrTail), 2_048);
			assert.equal(diagnostics[0].stderrTail.endsWith("-stderr-end"), true);
			assert.equal(diagnostics[0].stderrTruncated, true);
		});
	},
);

test(
	"native relay forwards SIGTERM and the SDK forwarded abort exactly once",
	{ skip: !relayBinary, timeout: 10_000 },
	async () => {
		for (const action of ["signal", "abort"]) {
			await withNativeRelay(async ({ endpoint, launchCapability, root }) => {
				const stateDirectory = path.join(root, "child-state");
				fs.mkdirSync(stateDirectory, { mode: 0o700 });
				const runtime = nativeSpawn(endpoint, launchCapability, stateDirectory, {
					mode: "wait",
				});
				await waitForPath(path.join(stateDirectory, "child.json"), "child_marker");
				let exitCount = 0;
				runtime.child.on("exit", () => {
					exitCount += 1;
				});
				const exited = once(runtime.child, "exit");
				if (action === "signal") assert.equal(runtime.child.kill("SIGTERM"), true);
				else runtime.abortController.abort();
				assert.deepEqual(await exited, [null, "SIGTERM"]);
				assert.equal(runtime.child.killed, true);
				assert.equal(exitCount, 1);
			});
		}
	},
);

test(
	"native relay rejects a replaced executable identity before spawning Claude",
	{ skip: !relayBinary, timeout: 10_000 },
	async () => {
		await withNativeRelay(async ({ endpoint, launchCapability, root }) => {
			const stateDirectory = path.join(root, "child-state");
			fs.mkdirSync(stateDirectory, { mode: 0o700 });
			const commandIdentity = {
				...nodeExecutableIdentity,
				inode: (BigInt(nodeExecutableIdentity.inode) + 1n).toString(),
			};
			const { child } = nativeSpawn(endpoint, launchCapability, stateDirectory, {
				commandIdentity,
			});
			const [error] = await once(child, "error");
			assert.match(error.message, /remote_launch_rejected/u);
			assert.equal(fs.existsSync(path.join(stateDirectory, "child.json")), false);
		}, 70);
	},
);

test(
	"native relay rejects a stale identity before spawning Claude",
	{ skip: !relayBinary, timeout: 10_000 },
	async () => {
		await withNativeRelay(async ({ endpoint, launchCapability, root }) => {
			const stateDirectory = path.join(root, "child-state");
			fs.mkdirSync(stateDirectory, { mode: 0o700 });
			const { child } = nativeSpawn(endpoint, launchCapability, stateDirectory, {
				identity: { ...identity, queryEpoch: "stale-query" },
			});
			const [error] = await once(child, "error");
			assert.match(error.message, /stale_identity|transport_closed/);
			assert.equal(fs.existsSync(path.join(stateDirectory, "child.json")), false);
		}, 70);
	},
);

test(
	"native relay terminates its child when the SDK host channel disconnects",
	{ skip: !relayBinary, timeout: 10_000 },
	async () => {
		let childProcessId;
		await withNativeRelay(async ({ endpoint, launchCapability, root }) => {
			const stateDirectory = path.join(root, "child-state");
			fs.mkdirSync(stateDirectory, { mode: 0o700 });
			const socket = net.createConnection({ path: endpoint });
			await once(socket, "connect");
			const decoder = new RelayFrameDecoder();
			const ready = new Promise((resolve, reject) => {
				socket.on("data", (chunk) => {
					try {
						for (const frame of decoder.push(chunk)) {
							if (frame.kind === RelayFrameKind.ready) resolve(frame);
						}
					} catch (error) {
						reject(error);
					}
				});
			});
			socket.write(
				encodeRelayFrame({
					kind: RelayFrameKind.hello,
					sequence: 1,
					identity,
					metadata: { launchCapability },
					payload: Buffer.from(
						JSON.stringify({
							command: process.execPath,
							commandIdentity: nodeExecutableIdentity,
							args: [
								fakeClaude,
								"--state-dir",
								stateDirectory,
								"--mode",
								"wait",
								"--exit-code",
								"0",
							],
							cwd: process.cwd(),
							env: { ...process.env },
						}),
					),
				}),
			);
			await ready;
			const markerPath = path.join(stateDirectory, "child.json");
			await waitForPath(markerPath, "child_marker");
			childProcessId = JSON.parse(fs.readFileSync(markerPath, "utf8")).pid;
			socket.destroy();
		}, 70);
		await waitForProcessAbsence(childProcessId);
	},
);
