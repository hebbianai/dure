import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { EventEmitter, once } from "node:events";

import { HostFrameDecoder, encodeHostFrame, hostProtocolError } from "./sdk-host-protocol.mjs";

const MAX_PENDING_REQUESTS = 128;

function clientError(reason) {
	const error = new Error(`dure_claude_sdk_host_client_${reason}`);
	error.code = "DURE_CLAUDE_SDK_HOST_CLIENT";
	return error;
}

function configuration(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw clientError("configuration_invalid");
	}
	if (typeof value.endpoint !== "string" || !path.isAbsolute(value.endpoint)) {
		throw clientError("endpoint_invalid");
	}
	const endpoint = path.resolve(value.endpoint);
	let parent;
	let socket;
	try {
		parent = fs.lstatSync(path.dirname(endpoint));
		socket = fs.lstatSync(endpoint);
	} catch {
		throw clientError("endpoint_unavailable");
	}
	if (
		!parent.isDirectory() ||
		parent.isSymbolicLink() ||
		(parent.mode & 0o077) !== 0 ||
		!socket.isSocket() ||
		socket.isSymbolicLink() ||
		(socket.mode & 0o077) !== 0 ||
		(typeof process.geteuid === "function" &&
			(parent.uid !== process.geteuid() || socket.uid !== process.geteuid()))
	) {
		throw clientError("endpoint_unsafe");
	}
	if (
		typeof value.capability !== "string" ||
		!/^[A-Za-z0-9._:-]{16,256}$/u.test(value.capability)
	) {
		throw clientError("capability_invalid");
	}
	if (typeof value.hostGeneration !== "string" || typeof value.clientGeneration !== "string") {
		throw clientError("generation_invalid");
	}
	if (!value.cursors || typeof value.cursors !== "object" || Array.isArray(value.cursors)) {
		throw clientError("cursors_invalid");
	}
	return {
		capability: value.capability,
		clientGeneration: value.clientGeneration,
		cursors: { ...value.cursors },
		endpoint,
		hostGeneration: value.hostGeneration,
	};
}

function remoteError(frame) {
	const reason = frame.error?.reason;
	if (typeof reason !== "string" || !/^[a-z0-9_]{1,64}$/u.test(reason)) {
		throw hostProtocolError("remote_error_invalid");
	}
	const error = new Error(`dure_claude_sdk_host_remote_${reason}`);
	error.code = "DURE_CLAUDE_SDK_HOST_REMOTE";
	return error;
}

class SharedClaudeSdkHostClient {
	#configuration;
	#decoder = new HostFrameDecoder();
	#events = new EventEmitter();
	#pending = new Map();
	#requestSequence = 0;
	#serverSequence = 0;
	#socket;
	#terminalError;

	constructor(parsedConfiguration) {
		this.#configuration = parsedConfiguration;
		this.#socket = net.createConnection({ path: parsedConfiguration.endpoint });
		this.#socket.on("data", (chunk) => this.#receiveBytes(chunk));
		this.#socket.on("error", (error) => this.#terminate(error));
		this.#socket.on("end", () => {
			try {
				this.#decoder.finish();
			} catch (error) {
				this.#terminate(error);
			}
		});
		this.#socket.on("close", () => this.#terminate(clientError("transport_closed")));
	}

	async attach() {
		await once(this.#socket, "connect");
		return this.#send({
			kind: "attach",
			capability: this.#configuration.capability,
			clientGeneration: this.#configuration.clientGeneration,
			cursors: this.#configuration.cursors,
		});
	}

	onEvent(listener) {
		this.#events.on("event", listener);
		return () => this.#events.off("event", listener);
	}

	#receiveBytes(chunk) {
		try {
			for (const frame of this.#decoder.push(chunk)) this.#receive(frame);
		} catch (error) {
			this.#terminate(error);
			this.#socket.destroy();
		}
	}

	#receive(frame) {
		if (
			frame.hostGeneration !== this.#configuration.hostGeneration ||
			!Number.isSafeInteger(frame.serverSequence) ||
			frame.serverSequence !== this.#serverSequence + 1
		) {
			throw hostProtocolError("stale_or_unordered_server_frame");
		}
		this.#serverSequence = frame.serverSequence;
		if (frame.kind === "event") {
			const value = { identity: frame.identity, event: frame.event };
			for (const listener of this.#events.listeners("event")) {
				try {
					listener(value);
				} catch {
					// Push observers cannot invalidate the replay-authoritative transport.
				}
			}
			return;
		}
		if (
			frame.kind !== "response" ||
			!Number.isSafeInteger(frame.requestSequence) ||
			(frame.ok !== true && frame.ok !== false)
		) {
			throw hostProtocolError("response_invalid");
		}
		const pending = this.#pending.get(frame.requestSequence);
		if (!pending) throw hostProtocolError("response_unmatched");
		const failure = frame.ok === false ? remoteError(frame) : null;
		this.#pending.delete(frame.requestSequence);
		if (frame.ok === true) pending.resolve(frame.result);
		else pending.reject(failure);
	}

	#send(frame) {
		if (this.#terminalError) return Promise.reject(this.#terminalError);
		if (this.#pending.size >= MAX_PENDING_REQUESTS) {
			return Promise.reject(clientError("pending_request_capacity_exceeded"));
		}
		const requestSequence = this.#requestSequence + 1;
		let encoded;
		try {
			encoded = encodeHostFrame({
				...frame,
				hostGeneration: this.#configuration.hostGeneration,
				requestSequence,
			});
		} catch (error) {
			return Promise.reject(error);
		}
		this.#requestSequence = requestSequence;
		const promise = new Promise((resolve, reject) => {
			this.#pending.set(requestSequence, { reject, resolve });
		});
		try {
			this.#socket.write(encoded);
		} catch (error) {
			this.#terminate(error);
			this.#socket.destroy();
		}
		return promise;
	}

	#request(action, payload = {}) {
		return this.#send({ action, kind: "request", payload });
	}

	bind(binding, replacement = {}) {
		return this.#request("bind", { binding, replacement });
	}

	startTurn(identity, turn) {
		return this.#request("start_turn", { identity, turn });
	}

	steerTurn(identity, turn) {
		return this.#request("steer_turn", { identity, turn });
	}

	interruptTurn(identity, request) {
		return this.#request("interrupt_turn", { identity, request });
	}

	answerInteraction(identity, answer) {
		return this.#request("answer_interaction", { answer, identity });
	}

	pendingInteractions(identity) {
		return this.#request("pending_interactions", { identity });
	}

	pendingSnapshot(identity) {
		return this.#request("pending_snapshot", { identity });
	}

	historyPage(identity, offset) {
		return this.#request("history_page", { identity, offset });
	}

	ackHistory(identity) {
		return this.#request("ack_history", { identity });
	}

	ack(identity, sequence) {
		return this.#request("ack", { identity, sequence });
	}

	replay(identity, afterSequence) {
		return this.#request("replay", { afterSequence, identity });
	}

	snapshot() {
		return this.#request("snapshot");
	}

	closeQuery(identity) {
		return this.#request("close_query", { identity });
	}

	closeQueryIfIdle(identity) {
		return this.#request("close_query_if_idle", { identity });
	}

	retireQuery(identity, retirement = {}) {
		return this.#request("retire_query", { identity, retirement });
	}

	retireQueryIfIdle(identity, retirement = {}) {
		return this.#request("retire_query_if_idle", { identity, retirement });
	}

	recoverQueryRetirement(identity, retirement) {
		return this.#request("recover_query_retirement", { identity, retirement });
	}

	queryRetirementStatus(identity) {
		return this.#request("query_retirement_status", { identity });
	}

	commitQueryReplacement(authority, target) {
		return this.#request("commit_query_replacement", { authority, target });
	}

	retargetQueryRetirement(authority, target) {
		return this.#request("retarget_query_retirement", { authority, target });
	}

	releaseQueryRetirement(authority) {
		return this.#request("release_query_retirement", { authority });
	}

	confirmQueryRetirementRelease(authority) {
		return this.#request("confirm_query_retirement_release", { authority });
	}

	beginDrain() {
		return this.#request("begin_drain");
	}

	shutdown() {
		return this.#request("shutdown");
	}

	async detach() {
		if (this.#socket.destroyed) return;
		const closed = once(this.#socket, "close");
		this.#socket.end();
		await closed;
	}

	#terminate(error) {
		if (this.#terminalError) return;
		this.#terminalError = error;
		for (const { reject } of this.#pending.values()) reject(error);
		this.#pending.clear();
		this.#events.emit("terminal", error);
	}
}

export async function connectSharedClaudeSdkHost(value) {
	const client = new SharedClaudeSdkHostClient(configuration(value));
	try {
		const snapshot = await client.attach();
		return Object.freeze({ client, snapshot });
	} catch (error) {
		await client.detach();
		throw error;
	}
}
