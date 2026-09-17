import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
	claudeRuntimeTarget,
	installClaudeRuntimeArtifact,
} from "./claude-runtime-artifact.mjs";
import { connectSharedClaudeSdkHost } from "./shared-sdk-host-client.mjs";

const relayBinary = process.env.DURE_CLAUDE_PROCESS_RELAY_BIN;
const driverDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = path.resolve(driverDirectory, "../../tests/fixtures");
const hostFixture = path.join(fixtureDirectory, "claude-shared-sdk-host-fixture.mjs");
const productionHostEntrypoint = path.join(driverDirectory, "shared-sdk-host-entrypoint.mjs");
const fakeClaude = path.join(fixtureDirectory, "fake-claude-relay-child.mjs");
const fakeAgentSdkClaude = path.join(fixtureDirectory, "fake-claude-agent-sdk-cli");
const fakeAgentSdkClaudeSource = path.join(
	fixtureDirectory,
	"fake-claude-agent-sdk-cli.mjs",
);
const timeoutMilliseconds = 10_000;

function delay(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(label, observe) {
	const deadline = Date.now() + timeoutMilliseconds;
	while (Date.now() < deadline) {
		const value = await observe();
		if (value !== undefined) return value;
		await delay(10);
	}
	throw new Error(`${label}_timeout`);
}

function readJsonIfPresent(target) {
	try {
		return JSON.parse(fs.readFileSync(target, "utf8"));
	} catch (error) {
		if (error?.code === "ENOENT" || error instanceof SyntaxError) return undefined;
		throw error;
	}
}

function processRow(processId) {
	const output = spawnSync("ps", ["-p", String(processId), "-o", "pid=,ppid=,rss=,command="], {
		encoding: "utf8",
	});
	if (output.status !== 0 || !output.stdout.trim()) return undefined;
	const match = output.stdout.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/u);
	if (!match) return undefined;
	return {
		command: match[4],
		parentPid: Number(match[2]),
		pid: Number(match[1]),
		rssKiB: Number(match[3]),
	};
}

function fileDescriptorSample(processId) {
	const program = fs.existsSync("/usr/sbin/lsof") ? "/usr/sbin/lsof" : "lsof";
	const output = spawnSync(program, ["-n", "-P", "-p", String(processId)], { encoding: "utf8" });
	if (output.error || output.status !== 0) return { descriptorCount: null, unixSocketCount: null };
	const rows = output.stdout.trim().split("\n").slice(1);
	return {
		descriptorCount: rows.length,
		unixSocketCount: rows.filter((row) => /\bunix\b/iu.test(row)).length,
	};
}

function identity(index, generation) {
	return Object.freeze({
		relayId: `relay-${index}-g${generation}`,
		queryEpoch: `query-${index}-g${generation}`,
		runtimeGeneration: `runtime-${index}-g${generation}`,
	});
}

async function startHost(generation, retiredIdentities = [], entrypoint = hostFixture) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-claude-shared-host-process-"));
	fs.chmodSync(root, 0o700);
	const endpoint = path.join(root, "host.sock");
	const capabilityFile = path.join(root, "host-capability");
	const capability = `shared-host-capability-${process.pid}-${Date.now()}-${generation}`;
	fs.writeFileSync(capabilityFile, capability, { flag: "wx", mode: 0o600 });
	const arguments_ = [
		entrypoint,
		"--capability-file",
		capabilityFile,
		"--endpoint",
		endpoint,
		"--host-generation",
		generation,
		"--state-dir",
		root,
	];
	if (entrypoint === productionHostEntrypoint) {
		const runtimeRoot = path.join(root, "claude-runtime");
		await installClaudeRuntimeArtifact({
			claudeCodeVersion: "2.1.234",
			runtimeRoot,
			sdkVersion: "0.3.234",
			sourceExecutable: fakeAgentSdkClaudeSource,
			target: claudeRuntimeTarget(),
		});
		arguments_.push("--runtime-root", runtimeRoot);
	}
	if (retiredIdentities.length > 0) {
		const retiredFile = path.join(root, "retired-identities.json");
		fs.writeFileSync(retiredFile, JSON.stringify(retiredIdentities), { flag: "wx", mode: 0o600 });
		arguments_.push("--retired-identities-file", retiredFile);
	}
	const child = spawn(process.execPath, arguments_, {
		cwd: process.cwd(),
		env: process.env,
		shell: false,
		stdio: ["ignore", "ignore", "pipe"],
	});
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const initialMarker = await waitFor("shared_host_ready", () => {
		if (child.exitCode !== null || child.signalCode !== null) {
			throw new Error(`shared_host_exited:${stderr}`);
		}
		const marker = readJsonIfPresent(path.join(root, "host.json"));
		if (!marker || !fs.existsSync(endpoint)) return undefined;
		return marker;
	});
	assert.equal(initialMarker.sdk.sdkVersion, "0.3.234");
	assert.equal(initialMarker.sdk.claudeCodeVersion, "2.1.234");
	assert.equal(initialMarker.sdk.nativePackagePresent, false);
	if (entrypoint === productionHostEntrypoint) {
		assert.equal(initialMarker.runtime.claudeCodeVersion, "2.1.234");
		assert.equal(initialMarker.runtime.sdkVersion, "0.3.234");
	} else {
		assert.equal(initialMarker.runtime, null);
	}
	return {
		capability,
		child,
		endpoint,
		generation,
		initialMarker,
		markerPath: path.join(root, "host.json"),
		root,
		stderr: () => stderr,
	};
}

async function connectHost(host, clientGeneration, cursors = {}) {
	return connectSharedClaudeSdkHost({
		capability: host.capability,
		clientGeneration,
		cursors,
		endpoint: host.endpoint,
		hostGeneration: host.generation,
	});
}

async function waitForHostReplay(client, queryIdentity, predicate) {
	return waitFor("host_replay", async () => {
		const replay = await client.replay(queryIdentity, 0);
		return predicate(replay) ? replay : undefined;
	});
}

async function sampleHost(host, previousSequence = 0) {
	if (!host.child.kill("SIGUSR1")) throw new Error("shared_host_sample_signal_failed");
	const marker = await waitFor("shared_host_sample", () => {
		const value = readJsonIfPresent(host.markerPath);
		return value?.sequence > previousSequence ? value : undefined;
	});
	return {
		...marker,
		...fileDescriptorSample(host.child.pid),
		process: processRow(host.child.pid),
	};
}

async function startRelay(
	index,
	generation,
	{ agentSdk = false, claudeCodeVersion = "2.1.234" } = {},
) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-claude-shared-host-relay-"));
	fs.chmodSync(root, 0o700);
	const endpoint = path.join(root, "relay.sock");
	const capabilityFile = path.join(root, "relay-capability");
	const relayCapability = `relay-capability-${process.pid}-${Date.now()}-${index}-${generation}`;
	fs.writeFileSync(capabilityFile, relayCapability, { flag: "wx", mode: 0o600 });
	const exactIdentity = identity(index, generation);
	const child = spawn(
		relayBinary,
		[
			"--endpoint",
			endpoint,
			"--capability-file",
			capabilityFile,
			"--runtime-generation",
			exactIdentity.runtimeGeneration,
			"--query-epoch",
			exactIdentity.queryEpoch,
			"--relay-id",
			exactIdentity.relayId,
		],
		{ env: process.env, shell: false, stdio: ["ignore", "ignore", "pipe"] },
	);
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	await waitFor("relay_ready", () => {
		if (child.exitCode !== null || child.signalCode !== null) {
			throw new Error(`relay_exited:${stderr}`);
		}
		return fs.existsSync(endpoint) ? true : undefined;
	});
	return {
		binding: {
			cwd: process.cwd(),
			env: {
				...(agentSdk
					? {
							CLAUDE_CONFIG_DIR: path.join(root, "claude-config"),
							DURE_FAKE_CLAUDE_CODE_VERSION: claudeCodeVersion,
							HOME: root,
						}
					: {}),
				DURE_QUERY_INDEX: String(index),
				PATH: process.env.PATH ?? "",
			},
			identity: exactIdentity,
			process: {
				args: agentSdk
					? []
					: [fakeClaude, "--state-dir", root, "--mode", "echo", "--exit-code", "0"],
				command: agentSdk ? fakeAgentSdkClaude : process.execPath,
				relayCapability,
				relayEndpoint: endpoint,
			},
		},
		child,
		childMarkerPath: path.join(root, "child.json"),
		identity: exactIdentity,
		root,
		stderr: () => stderr,
	};
}

test(
	"the pinned Agent SDK query streams through one exact native relay without an account or network",
	{ skip: !relayBinary, timeout: 30_000 },
	async () => {
		const hosts = [];
		const relays = [];
		try {
			const host = await startHost("host-real-sdk-relay-1", [], productionHostEntrypoint);
			hosts.push(host);
			const relay = await startRelay(40, 1, { agentSdk: true });
			relays.push(relay);
			const { client } = await connectHost(host, "client-real-sdk-relay-1");
			try {
				await client.bind(relay.binding);
			} catch (error) {
				throw new Error(
					`real_sdk_bind_failed:${error.message}:host=${host.stderr()}:relay=${relay.stderr()}`,
					{ cause: error },
				);
			}
			await client.startTurn(relay.identity, {
				clientMessageId: "real-sdk-relay-message-1",
				input: "hello-through-sdk",
			});
			const replay = await waitForHostReplay(client, relay.identity, ({ events }) =>
				events.some(({ kind }) => kind === "turn_completed"),
			);
			// The provider process warms lazily at the first turn, so its
			// session-initialized report lands inside that turn, after the
			// user message is accepted.
			assert.deepEqual(
				replay.events.map(({ kind }) => kind),
				[
					"initialized",
					"user_message_accepted",
					"provider_session_initialized",
					"assistant_delta",
					"assistant_message_completed",
					"provider_turn_result",
					"turn_completed",
				],
			);
			assert.equal(
				replay.events.find(({ kind }) => kind === "assistant_delta").payload.text,
				"sdk-echo:hello-through-sdk",
			);
			assert.equal(
				replay.events.find(({ kind }) => kind === "provider_turn_result").payload
					.providerSessionId,
				"99999999-8888-4777-8666-555555555555",
			);
			await client.startTurn(relay.identity, {
				clientMessageId: "real-sdk-relay-message-2",
				input: "second-turn-same-query",
			});
			const secondReplay = await waitForHostReplay(
				client,
				relay.identity,
				({ events }) => events.filter(({ kind }) => kind === "turn_completed").length === 2,
			);
			assert.deepEqual(
				secondReplay.events
					.filter(({ kind }) => kind === "assistant_delta")
					.map(({ payload }) => payload.text),
				["sdk-echo:hello-through-sdk", "sdk-echo:second-turn-same-query"],
			);
			assert.equal(
				secondReplay.events.filter(({ kind }) => kind === "provider_session_initialized")
					.length,
				1,
			);
			await client.startTurn(relay.identity, {
				clientMessageId: "real-sdk-relay-permission-message-1",
				input: "permission-through-sdk",
			});
			await waitForHostReplay(client, relay.identity, ({ events }) =>
				events.some(({ kind }) => kind === "interaction_requested"),
			);
			const permission = (await client.pendingInteractions(relay.identity))[0];
			assert.deepEqual(
				{
					kind: permission.kind,
					toolName: permission.toolName,
					toolUseId: permission.toolUseId,
				},
				{
					kind: "permission",
					toolName: "Write",
					toolUseId: "fake-permission-tool-use-1",
				},
			);
			await client.answerInteraction(relay.identity, {
				clientMessageId: permission.clientMessageId,
				decision: "allow",
				kind: permission.kind,
				requestId: permission.requestId,
			});
			await waitForHostReplay(
				client,
				relay.identity,
				({ events }) => events.filter(({ kind }) => kind === "turn_completed").length === 3,
			);
			assert.deepEqual(await client.pendingInteractions(relay.identity), []);

			await client.startTurn(relay.identity, {
				clientMessageId: "real-sdk-relay-question-message-1",
				input: "question-through-sdk",
			});
			await waitFor("real_sdk_question", async () => {
				const pending = await client.pendingInteractions(relay.identity);
				return pending[0]?.kind === "question" ? pending[0] : undefined;
			});
			const question = (await client.pendingInteractions(relay.identity))[0];
			assert.equal(
				question.input.questions[0].question,
				"Which database should we use?",
			);
			await client.answerInteraction(relay.identity, {
				answers: { "Which database should we use?": "SQLite" },
				clientMessageId: question.clientMessageId,
				kind: question.kind,
				requestId: question.requestId,
			});
			await waitForHostReplay(
				client,
				relay.identity,
				({ events }) => events.filter(({ kind }) => kind === "turn_completed").length === 4,
			);

			await client.startTurn(relay.identity, {
				clientMessageId: "real-sdk-relay-interrupt-message-1",
				input: "interrupt-through-sdk",
			});
			const interruptReceipt = await client.interruptTurn(relay.identity, {
				clientMessageId: "real-sdk-relay-interrupt-message-1",
				interruptRequestId: "real-sdk-relay-interrupt-request-1",
			});
			assert.equal(interruptReceipt.receiptAvailable, true);
			assert.deepEqual(interruptReceipt.stillQueuedMessageIds, []);
			const controlledReplay = await waitForHostReplay(
				client,
				relay.identity,
				({ events }) => events.filter(({ kind }) => kind === "turn_completed").length === 5,
			);
			assert.equal(
				controlledReplay.events.some(
					({ kind }) => kind === "provider_turn_interrupt_acknowledged",
				),
				true,
			);
			assert.equal((await client.beginDrain()).affected.length, 1);
			await client.closeQuery(relay.identity);
			await client.ack(
				relay.identity,
				(await client.replay(relay.identity, 0)).latestSequence,
			);
			await waitForExit(relay.child, "real_sdk_relay_drain");
			await client.shutdown();
			await waitForExit(host.child, "real_sdk_host_drain");
		} finally {
			await cleanup(hosts, relays);
		}
	},
);

test(
	"an incompatible Claude executable is rejected and its exact relay exits",
	{ skip: !relayBinary, timeout: 30_000 },
	async () => {
		const hosts = [];
		const relays = [];
		try {
			const host = await startHost(
				"host-real-sdk-version-mismatch-1",
				[],
				productionHostEntrypoint,
			);
			hosts.push(host);
			const relay = await startRelay(41, 1, {
				agentSdk: true,
				claudeCodeVersion: "2.1.233",
			});
			relays.push(relay);
			const { client } = await connectHost(host, "client-real-sdk-version-mismatch-1");
			// Bind is lazy — the incompatible executable is only discovered when
			// the first turn warms the provider process, and the exact relay
			// exits with it.
			await client.bind(relay.binding);
			// Bind is lazy: the incompatible executable is only discovered when
			// the first turn warms the provider process. The turn is accepted,
			// the warm-up fails, and the Query exits with its exact relay.
			await client.startTurn(relay.identity, {
				clientMessageId: "real-sdk-version-mismatch-message-1",
				input: "never-delivered",
			});
			await waitForHostReplay(client, relay.identity, ({ events }) =>
				events.some(({ kind }) => kind === "query_exited"),
			);
			await waitForExit(relay.child, "incompatible_real_sdk_relay");
			const snapshot = await client.snapshot();
			assert.equal(snapshot.queries.length, 1);
			assert.equal(snapshot.queries[0].state, "exited");
			await client.beginDrain();
			await client.closeQuery(relay.identity);
			await client.ack(
				relay.identity,
				(await client.replay(relay.identity, 0)).latestSequence,
			);
			await client.shutdown();
			await waitForExit(host.child, "incompatible_real_sdk_host_drain");
		} finally {
			await cleanup(hosts, relays);
		}
	},
);

async function waitForRelayTree(relay) {
	const marker = await waitFor("fake_claude_ready", () => readJsonIfPresent(relay.childMarkerPath));
	assert.equal(marker.parentPid, relay.child.pid);
	assert.equal(processRow(relay.child.pid)?.parentPid, process.pid);
	assert.equal(processRow(marker.pid)?.parentPid, relay.child.pid);
	return marker;
}

async function waitForExit(child, label) {
	if (child.exitCode !== null || child.signalCode !== null) return;
	let timeout;
	try {
		await Promise.race([
			once(child, "exit"),
			new Promise((_, reject) => {
				timeout = setTimeout(() => reject(new Error(`${label}_exit_timeout`)), timeoutMilliseconds);
			}),
		]);
	} finally {
		clearTimeout(timeout);
	}
}

async function stopProcess(child, signal = "SIGTERM") {
	if (child.exitCode === null && child.signalCode === null) child.kill(signal);
	await waitForExit(child, "cleanup_process");
}

async function cleanup(hosts, relays) {
	for (const host of hosts) await stopProcess(host.child, "SIGKILL");
	for (const relay of relays) await stopProcess(relay.child);
	for (const relay of relays) fs.rmSync(relay.root, { force: true, recursive: true });
	for (const host of hosts) fs.rmSync(host.root, { force: true, recursive: true });
}

test(
	"one shared process binds 1, 5, and 20 exact relay Queries and survives client detach",
	{ skip: !relayBinary, timeout: 60_000 },
	async () => {
		const hosts = [];
		const relays = [];
		try {
			const host = await startHost("host-matrix-process-1");
			hosts.push(host);
			let { client } = await connectHost(host, "client-matrix-process-1");
			const matrix = [];
			let markerSequence = host.initialMarker.sequence;
			for (let index = 0; index < 20; index += 1) {
				const relay = await startRelay(index, 1);
				relays.push(relay);
				await client.bind(relay.binding);
				const marker = await waitForRelayTree(relay);
				await client.startTurn(relay.identity, {
					clientMessageId: `message-${index}`,
					input: `echo-${index}`,
				});
				const replay = await waitForHostReplay(client, relay.identity, ({ events }) =>
					events.some(({ kind }) => kind === "turn_completed"),
				);
				assert.equal(replay.events.find(({ kind }) => kind === "assistant_delta").payload.text, `echo-${index}`);
				assert.notEqual(marker.pid, host.child.pid);

				const count = index + 1;
				if ([1, 5, 20].includes(count)) {
					const sample = await sampleHost(host, markerSequence);
					markerSequence = sample.sequence;
					assert.equal(sample.queryCount, count);
					assert.equal(sample.process.parentPid, process.pid);
					matrix.push({
						activeResourceCount: sample.activeResources.length,
						descriptorCount: sample.descriptorCount,
						heapUsedBytes: sample.memoryUsage.heapUsed,
						queryCount: count,
						rssBytes: sample.memoryUsage.rss,
						unixSocketCount: sample.unixSocketCount,
					});
				}
				if (count === 5) {
					await client.detach();
					await delay(100);
					for (const current of relays) assert.ok(processRow(current.child.pid));
					const reattached = await connectHost(host, "client-matrix-process-2");
					client = reattached.client;
					assert.equal(reattached.snapshot.queries.length, 5);
				}
			}
			console.log(`CLAUDE_SHARED_HOST_MATRIX ${JSON.stringify(matrix)}`);
			assert.equal((await client.beginDrain()).affected.length, 20);
			for (const relay of relays) {
				await client.closeQuery(relay.identity);
				await client.ack(
					relay.identity,
					(await client.replay(relay.identity, 0)).latestSequence,
				);
				await waitForExit(relay.child, "relay_drain");
			}
			await client.shutdown();
			await waitForExit(host.child, "host_drain");
		} finally {
			await cleanup(hosts, relays);
		}
	},
);

test(
	"rolling drain rehosts one Query at a time and a host crash leaves no adoptable relay stdio",
	{ skip: !relayBinary, timeout: 60_000 },
	async () => {
		const hosts = [];
		const relays = [];
		try {
			const oldHost = await startHost("host-rolling-process-old");
			hosts.push(oldHost);
			const { client: oldClient } = await connectHost(oldHost, "client-rolling-process-old");
			const oldRelays = [];
			for (let index = 0; index < 5; index += 1) {
				const relay = await startRelay(index, 1);
				relays.push(relay);
				oldRelays.push(relay);
				await oldClient.bind(relay.binding);
				await waitForRelayTree(relay);
			}

			const replacementHost = await startHost("host-rolling-process-new");
			hosts.push(replacementHost);
			const { client: replacementClient } = await connectHost(
				replacementHost,
				"client-rolling-process-new",
			);
			assert.equal((await oldClient.beginDrain()).affected.length, 5);
			const replacementRelays = [];
			for (let index = 0; index < 5; index += 1) {
				const replacementRelay = await startRelay(index, 2);
				relays.push(replacementRelay);
				replacementRelays.push(replacementRelay);
				await oldClient.retireQuery(oldRelays[index].identity, {
					allowedTarget: replacementRelay.identity,
				});
				await oldClient.ack(
					oldRelays[index].identity,
					(await oldClient.replay(oldRelays[index].identity, 0)).latestSequence,
				);
				await waitForExit(oldRelays[index].child, "old_relay_drain");
				const authority = (await oldClient.queryRetirementStatus(oldRelays[index].identity))
					.authority;
				await replacementClient.bind(replacementRelay.binding, {
					authority,
				});
				const committed = await replacementClient.commitQueryReplacement(
					authority,
					replacementRelay.identity,
				);
				const released = await replacementClient.releaseQueryRetirement(
					committed.authority,
				);
				await replacementClient.confirmQueryRetirementRelease(released.authority);
				await waitForRelayTree(replacementRelay);
				assert.equal((await oldClient.snapshot()).queries.filter(({ state }) => state !== "exited").length, 4 - index);
				assert.equal((await replacementClient.snapshot()).queries.filter(({ state }) => state !== "exited").length, index + 1);
			}
			await oldClient.shutdown();
			await waitForExit(oldHost.child, "old_host_drain");

			replacementHost.child.kill("SIGKILL");
			await waitForExit(replacementHost.child, "replacement_host_crash");
			for (const relay of replacementRelays) {
				await waitForExit(relay.child, "relay_after_host_crash");
				const marker = readJsonIfPresent(relay.childMarkerPath);
				await waitFor("fake_claude_after_host_crash", () =>
					processRow(marker.pid) === undefined ? true : undefined,
				);
			}

			const recoveryHost = await startHost(
				"host-rolling-process-recovery",
				replacementRelays.map(({ identity: value }) => value),
			);
			hosts.push(recoveryHost);
			const { client: recoveryClient } = await connectHost(
				recoveryHost,
				"client-rolling-process-recovery",
			);
			await assert.rejects(
				recoveryClient.bind(replacementRelays[0].binding),
				/dure_claude_sdk_host_remote_stale_runtime_generation/u,
			);
			const recoveredRelay = await startRelay(0, 3);
			relays.push(recoveredRelay);
			const recoveryAuthority = await recoveryClient.queryRetirementStatus(
				replacementRelays[0].identity,
			);
			const retargeted = await recoveryClient.retargetQueryRetirement(
				recoveryAuthority.authority,
				recoveredRelay.identity,
			);
			await recoveryClient.bind(recoveredRelay.binding, {
				authority: retargeted.authority,
			});
			await waitForRelayTree(recoveredRelay);
			assert.equal((await recoveryClient.beginDrain()).affected.length, 1);
			await recoveryClient.closeQuery(recoveredRelay.identity);
			await recoveryClient.ack(
				recoveredRelay.identity,
				(await recoveryClient.replay(recoveredRelay.identity, 0)).latestSequence,
			);
			await waitForExit(recoveredRelay.child, "recovered_relay_drain");
			await recoveryClient.shutdown();
			await waitForExit(recoveryHost.child, "recovery_host_drain");
		} finally {
			await cleanup(hosts, relays);
		}
	},
);
