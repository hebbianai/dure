import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { HostFrameDecoder, encodeHostFrame } from "./sdk-host-protocol.mjs";
import { createSharedClaudeSdkHost, hostContractError } from "./shared-sdk-host.mjs";

const MAX_CAPABILITY_BYTES = 256;
const MAX_QUEUED_REQUESTS = 128;

function serverError(reason) {
	const error = new Error(`dure_claude_sdk_host_server_${reason}`);
	error.code = "DURE_CLAUDE_SDK_HOST_SERVER";
	return error;
}

function ownedDirectory(target) {
	const metadata = fs.lstatSync(target);
	return (
		metadata.isDirectory() &&
		!metadata.isSymbolicLink() &&
		(metadata.mode & 0o077) === 0 &&
		(typeof process.geteuid !== "function" || metadata.uid === process.geteuid())
	);
}

function readCapability(target) {
	const metadata = fs.lstatSync(target);
	if (
		!metadata.isFile() ||
		metadata.isSymbolicLink() ||
		(metadata.mode & 0o077) !== 0 ||
		metadata.size < 16 ||
		metadata.size > MAX_CAPABILITY_BYTES ||
		(typeof process.geteuid === "function" && metadata.uid !== process.geteuid())
	) {
		throw serverError("capability_file_unsafe");
	}
	const capability = fs.readFileSync(target, "utf8");
	if (!/^[A-Za-z0-9._:-]{16,256}$/u.test(capability)) {
		throw serverError("capability_invalid");
	}
	fs.unlinkSync(target);
	return capability;
}

function serverConfiguration(configuration) {
	if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
		throw serverError("configuration_invalid");
	}
	if (typeof configuration.endpoint !== "string" || !path.isAbsolute(configuration.endpoint)) {
		throw serverError("endpoint_invalid");
	}
	const endpoint = path.resolve(configuration.endpoint);
	if (Buffer.byteLength(endpoint, "utf8") >= 100) throw serverError("endpoint_path_too_long");
	if (!ownedDirectory(path.dirname(endpoint))) throw serverError("endpoint_parent_unsafe");
	try {
		fs.lstatSync(endpoint);
		throw serverError("endpoint_exists");
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
	if (
		typeof configuration.capabilityFile !== "string" ||
		!path.isAbsolute(configuration.capabilityFile)
	) {
		throw serverError("capability_file_invalid");
	}
	const capabilityFile = path.resolve(configuration.capabilityFile);
	if (path.dirname(capabilityFile) !== path.dirname(endpoint)) {
		throw serverError("capability_boundary_mismatch");
	}
	const host = createSharedClaudeSdkHost(configuration);
	return {
		capability: readCapability(capabilityFile),
		endpoint,
		host,
	};
}

function positiveSequence(value, expected) {
	if (!Number.isSafeInteger(value) || value !== expected) {
		throw serverError("request_sequence_invalid");
	}
	return value;
}

export function errorReason(error) {
	if (typeof error?.message !== "string") return "internal_error";
	for (const prefix of [
		"dure_claude_sdk_host_",
		"dure_claude_sdk_host_protocol_",
		"dure_claude_sdk_host_server_",
		"dure_claude_agent_sdk_",
	]) {
		if (error.message.startsWith(prefix)) {
			const reason = error.message.slice(prefix.length);
			if (/^[a-z0-9_]{1,64}$/u.test(reason)) return reason;
		}
	}
	// An unrecognized exception still travels as a bounded token: masking it
	// as a bare "internal_error" hides the one fact an operator needs.
	const sanitized = error.message
		.toLowerCase()
		.replace(/[^a-z0-9_]+/gu, "_")
		.replace(/^_+|_+$/gu, "")
		.slice(0, 48);
	return sanitized ? `internal_error_${sanitized}` : "internal_error";
}

function requestPayload(frame) {
	if (!frame.payload || typeof frame.payload !== "object" || Array.isArray(frame.payload)) {
		throw serverError("request_payload_invalid");
	}
	return frame.payload;
}

export async function startSharedClaudeSdkHostServer(configuration) {
	const { endpoint, capability, host } = serverConfiguration(configuration);
	const sockets = new Set();
	let closed = false;
	let closeResolve;
	const closedPromise = new Promise((resolve) => {
		closeResolve = resolve;
	});

	const server = net.createServer((socket) => {
		sockets.add(socket);
		const decoder = new HostFrameDecoder();
		let connection;
		let expectedRequestSequence = 1;
		let queuedRequestCount = 0;
		let serverSequence = 0;
		let requestQueue = Promise.resolve();
		let unsubscribe;

		const send = (value) => {
			if (!socket.destroyed) {
				socket.write(
					encodeHostFrame({
						...value,
						hostGeneration: host.hostGeneration,
						serverSequence: ++serverSequence,
					}),
				);
			}
		};
		const respond = (requestSequence, result) => {
			send({ kind: "response", ok: true, requestSequence, result: result ?? null });
		};
		const reject = (requestSequence, error) => {
			send({
				kind: "response",
				ok: false,
				requestSequence,
				error: { reason: errorReason(error) },
			});
		};

		const dispatch = async (frame) => {
			if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
				throw serverError("request_invalid");
			}
			const requestSequence = positiveSequence(
				frame.requestSequence,
				expectedRequestSequence++,
			);
			try {
				if (!connection) {
					if (
						frame.kind !== "attach" ||
						frame.hostGeneration !== host.hostGeneration ||
						frame.capability !== capability
					) {
						throw serverError("attach_denied");
					}
					connection = host.attach({
						hostGeneration: frame.hostGeneration,
						clientGeneration: frame.clientGeneration,
						cursors: frame.cursors,
					});
					unsubscribe = connection.onEvent((identity, event) => {
						send({ kind: "event", identity, event });
					});
					respond(requestSequence, connection.snapshot());
					return;
				}
				if (frame.kind !== "request" || frame.hostGeneration !== host.hostGeneration) {
					throw serverError("request_invalid");
				}
				const payload = requestPayload(frame);
				switch (frame.action) {
					case "bind":
						respond(
							requestSequence,
							await connection.bind(payload.binding, payload.replacement),
						);
						break;
					case "start_turn":
						respond(
							requestSequence,
							connection.startTurn(payload.identity, payload.turn),
						);
						break;
					case "steer_turn":
						respond(
							requestSequence,
							connection.steerTurn(payload.identity, payload.turn),
						);
						break;
					case "interrupt_turn":
						respond(
							requestSequence,
							await connection.interruptTurn(payload.identity, payload.request),
						);
						break;
					case "answer_interaction":
						respond(
							requestSequence,
							await connection.answerInteraction(payload.identity, payload.answer),
						);
						break;
					case "pending_interactions":
						respond(
							requestSequence,
							connection.pendingInteractions(payload.identity),
						);
						break;
					case "pending_snapshot":
						respond(requestSequence, connection.pendingSnapshot(payload.identity));
						break;
					case "history_page":
						respond(
							requestSequence,
							connection.historyPage(payload.identity, payload.offset),
						);
						break;
					case "ack_history":
						respond(requestSequence, connection.ackHistory(payload.identity));
						break;
					case "ack":
						connection.ack(payload.identity, payload.sequence);
						respond(requestSequence);
						break;
					case "replay":
						respond(
							requestSequence,
							connection.replay(payload.identity, payload.afterSequence),
						);
						break;
					case "snapshot":
						respond(requestSequence, connection.snapshot());
						break;
					case "close_query":
						respond(requestSequence, await connection.closeQuery(payload.identity));
						break;
					case "close_query_if_idle":
						respond(requestSequence, await connection.closeQueryIfIdle(payload.identity));
						break;
					case "retire_query":
						respond(
							requestSequence,
							await connection.retireQuery(payload.identity, payload.retirement),
						);
						break;
					case "retire_query_if_idle":
						respond(
							requestSequence,
							await connection.retireQueryIfIdle(payload.identity, payload.retirement),
						);
						break;
					case "recover_query_retirement":
						respond(
							requestSequence,
							connection.recoverQueryRetirement(payload.identity, payload.retirement),
						);
						break;
					case "query_retirement_status":
						respond(requestSequence, connection.queryRetirementStatus(payload.identity));
						break;
					case "commit_query_replacement":
						respond(
							requestSequence,
							connection.commitQueryReplacement(payload.authority, payload.target),
						);
						break;
					case "retarget_query_retirement":
						respond(
							requestSequence,
							connection.retargetQueryRetirement(payload.authority, payload.target),
						);
						break;
					case "release_query_retirement":
						respond(requestSequence, connection.releaseQueryRetirement(payload.authority));
						break;
					case "confirm_query_retirement_release":
						respond(
							requestSequence,
							connection.confirmQueryRetirementRelease(payload.authority),
						);
						break;
					case "begin_drain":
						respond(requestSequence, { affected: connection.beginDrain() });
						break;
					case "shutdown":
						if (host.state !== "drained") throw hostContractError("shutdown_not_drained");
						respond(requestSequence, { state: host.state });
						setImmediate(() => {
							socket.end();
							server.close();
						});
						break;
					default:
						throw serverError("action_unsupported");
				}
			} catch (error) {
				reject(requestSequence, error);
				if (!connection) setImmediate(() => socket.end());
			}
		};

		socket.on("data", (chunk) => {
			let frames;
			try {
				frames = decoder.push(chunk);
			} catch {
				socket.destroy();
				return;
			}
			for (const frame of frames) {
				if (queuedRequestCount >= MAX_QUEUED_REQUESTS) {
					socket.destroy();
					return;
				}
				queuedRequestCount += 1;
				requestQueue = requestQueue
					.then(() => {
						if (!socket.destroyed) return dispatch(frame);
					})
					.catch(() => socket.destroy())
					.finally(() => {
						queuedRequestCount -= 1;
					});
			}
		});
		socket.on("end", () => {
			try {
				decoder.finish();
			} catch {
				socket.destroy();
			}
		});
		socket.on("close", () => {
			unsubscribe?.();
			connection?.detach();
			sockets.delete(socket);
		});
	});

	server.on("close", () => {
		closed = true;
		try {
			fs.unlinkSync(endpoint);
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
		}
		closeResolve();
	});
	server.listen(endpoint);
	await new Promise((resolve, reject) => {
		server.once("listening", resolve);
		server.once("error", reject);
	});
	fs.chmodSync(endpoint, 0o600);

	return Object.freeze({
		closed: closedPromise,
		endpoint,
		host,
		async close() {
			if (closed) return;
			if (host.state !== "drained" && host.state !== "failed") {
				await host.fail("host_server_closed");
			}
			for (const socket of sockets) socket.destroy();
			await new Promise((resolve) => server.close(resolve));
			await closedPromise;
		},
	});
}
