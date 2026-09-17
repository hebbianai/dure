import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";

import {
	MAX_RELAY_STREAM_BYTES,
	MAX_RELAY_STDERR_BYTES,
	RELAY_SUPPORTED_SIGNALS,
	RelayFrameDecoder,
	RelayFrameKind,
	encodeRelayFrame,
	relayIdentityMatches,
	relayProtocolError,
} from "./process-relay-protocol.mjs";

const MAX_PENDING_STDIN_BYTES = 1024 * 1024;
const RELAY_ENDPOINT_WAIT_MS = 10_000;
const RELAY_ENDPOINT_POLL_MS = 50;
const supportedSignals = new Set(RELAY_SUPPORTED_SIGNALS);
const exitSignals = new Set(
	Object.keys(os.constants.signals).filter((signal) => signal.startsWith("SIG")),
);

function relayConfiguration(configuration) {
	if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
		throw relayProtocolError("configuration_invalid");
	}
	const endpoint = path.resolve(configuration.endpoint ?? "");
	const parent = fs.lstatSync(path.dirname(endpoint));
	if (
		!parent.isDirectory() ||
		parent.isSymbolicLink() ||
		parent.mode & 0o077 ||
		(typeof process.geteuid === "function" && parent.uid !== process.geteuid())
	) {
		throw relayProtocolError("endpoint_parent_unsafe");
	}
	// The endpoint socket itself is validated in validateEndpointSocket right
	// before each connection attempt: the relay binds it only after its own
	// session boots, so requiring it at configuration time races that boot.
	const launchCapability = configuration.launchCapability;
	if (
		typeof launchCapability !== "string" ||
		launchCapability.length < 16 ||
		launchCapability.length > 256 ||
		/[\u0000-\u001f\u007f]/u.test(launchCapability)
	) {
		throw relayProtocolError("launch_capability_invalid");
	}
	if (
		configuration.onDiagnostic !== undefined &&
		typeof configuration.onDiagnostic !== "function"
	) {
		throw relayProtocolError("diagnostic_handler_invalid");
	}
	return {
		endpoint,
		identity: configuration.identity,
		launchCapability,
		onDiagnostic: configuration.onDiagnostic,
	};
}

function executableIdentity(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw relayProtocolError("spawn_command_identity_invalid");
	}
	const keys = [
		"changedNanoseconds",
		"changedSeconds",
		"device",
		"inode",
		"modifiedNanoseconds",
		"modifiedSeconds",
		"sha256",
		"size",
	];
	if (
		Object.keys(value).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(value, key)) ||
		!["changedSeconds", "device", "inode", "modifiedSeconds", "size"].every(
			(key) => typeof value[key] === "string" && /^(?:0|[1-9][0-9]{0,19})$/u.test(value[key]),
		) ||
		typeof value.changedNanoseconds !== "string" ||
		!/^(?:0|[1-9][0-9]{0,8})$/u.test(value.changedNanoseconds) ||
		BigInt(value.changedNanoseconds) >= 1_000_000_000n ||
		typeof value.modifiedNanoseconds !== "string" ||
		!/^(?:0|[1-9][0-9]{0,8})$/u.test(value.modifiedNanoseconds) ||
		BigInt(value.modifiedNanoseconds) >= 1_000_000_000n ||
		typeof value.sha256 !== "string" ||
		!/^sha256:[0-9a-f]{64}$/u.test(value.sha256)
	) {
		throw relayProtocolError("spawn_command_identity_invalid");
	}
	return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

function launchSpecification(options) {
	if (!options || typeof options !== "object" || Array.isArray(options)) {
		throw relayProtocolError("spawn_options_invalid");
	}
	if (
		typeof options.command !== "string" ||
		options.command.length === 0 ||
		!path.isAbsolute(options.command)
	) {
		throw relayProtocolError("spawn_command_invalid");
	}
	if (!Array.isArray(options.args) || options.args.some((value) => typeof value !== "string")) {
		throw relayProtocolError("spawn_arguments_invalid");
	}
	const cwd = path.resolve(options.cwd ?? process.cwd());
	if (!options.env || typeof options.env !== "object" || Array.isArray(options.env)) {
		throw relayProtocolError("spawn_environment_invalid");
	}
	const env = {};
	for (const [key, value] of Object.entries(options.env)) {
		if (typeof value === "string") env[key] = value;
		else if (value !== undefined) throw relayProtocolError("spawn_environment_value_invalid");
	}
	if (!options.signal || typeof options.signal.addEventListener !== "function") {
		throw relayProtocolError("spawn_signal_invalid");
	}
	return {
		launch: {
			args: [...options.args],
			command: options.command,
			commandIdentity: executableIdentity(options.commandIdentity),
			cwd,
			env,
		},
		signal: options.signal,
	};
}

class RelaySpawnedProcess {
	#configuration;
	#decoder = new RelayFrameDecoder();
	#events = new EventEmitter();
	#socket;
	#state = "connecting";
	#sendSequence = 0;
	#receiveSequence = 0;
	#helloSequence;
	#pendingWrite;
	#pendingStdinSequence;
	#pendingFinal;
	#pendingEofSequence;
	#pendingStdoutSequence;
	#pendingControl;
	#pendingControlSequence;
	#pendingControlKind;
	#stdoutEnded = false;
	#terminalEventDelivered = false;
	#abortHandler;
	#abortSignal;
	#killed = false;
	#exitCode = null;
	#signalCode = null;

	constructor(configuration, options) {
		this.#configuration = configuration;
		const { launch, signal } = launchSpecification(options);
		this.stdin = new Writable({
			highWaterMark: MAX_RELAY_STREAM_BYTES,
			write: (chunk, _encoding, callback) => this.#writeStdin(chunk, callback),
			final: (callback) => this.#finishStdin(callback),
		});
		this.stdout = new Readable({
			highWaterMark: MAX_RELAY_STREAM_BYTES,
			read: () => this.#resumeStdout(),
		});

		this.#connectWhenBound(launch, Date.now() + RELAY_ENDPOINT_WAIT_MS);

		this.#abortSignal = signal;
		this.#abortHandler = () => {
			if (this.#terminalEventDelivered || this.#killed) return;
			this.#killed = true;
			this.#requestControl(RelayFrameKind.abort, {});
		};
		signal.addEventListener("abort", this.#abortHandler, { once: true });
		if (signal.aborted) this.#abortHandler();
	}

	// The relay binds its endpoint only after its own hmux session boots, then
	// narrows its permissions before publishing it. Waiting for both steps (and
	// retrying a refused connection) inside one bounded window turns that boot
	// race into ordering; the deadline still fails closed on a relay that never
	// becomes safe. Nothing writes to the socket before the hello handshake
	// flips the state to "ready", so deferring the connection is protocol-neutral.
	#connectWhenBound(launch, deadline) {
		if (this.#terminalEventDelivered || this.#state === "failed") return;
		let socketStat;
		try {
			socketStat = fs.lstatSync(this.#configuration.endpoint);
		} catch {
			this.#retryConnect(launch, deadline, "endpoint_unavailable");
			return;
		}
		if (
			!socketStat.isSocket() ||
			socketStat.isSymbolicLink() ||
			(typeof process.geteuid === "function" && socketStat.uid !== process.geteuid())
		) {
			this.#fail(relayProtocolError("endpoint_invalid"));
			return;
		}
		if (socketStat.mode & 0o077) {
			this.#retryConnect(launch, deadline, "endpoint_permissions_unavailable");
			return;
		}
		const socket = net.createConnection({ path: this.#configuration.endpoint });
		this.#socket = socket;
		let connected = false;
		socket.on("connect", () => {
			connected = true;
			try {
				this.#helloSequence = this.#send(
					RelayFrameKind.hello,
					{ launchCapability: this.#configuration.launchCapability },
					Buffer.from(JSON.stringify(launch), "utf8"),
				);
			} catch (error) {
				this.#fail(error);
			}
		});
		socket.on("data", (chunk) => {
			try {
				for (const frame of this.#decoder.push(chunk)) this.#receive(frame);
			} catch (error) {
				this.#fail(error);
			}
		});
		socket.on("error", (error) => {
			if (
				!connected &&
				(error?.code === "ECONNREFUSED" || error?.code === "ENOENT")
			) {
				socket.destroy();
				this.#socket = undefined;
				this.#retryConnect(launch, deadline, "endpoint_unavailable");
				return;
			}
			this.#fail(error);
		});
		socket.on("end", () => {
			try {
				this.#decoder.finish();
			} catch (error) {
				this.#fail(error);
				return;
			}
			if (!this.#terminalEventDelivered) this.#fail(relayProtocolError("transport_closed"));
		});
	}

	#retryConnect(launch, deadline, reason) {
		if (this.#terminalEventDelivered || this.#state === "failed") return;
		if (Date.now() >= deadline) {
			this.#fail(relayProtocolError(reason));
			return;
		}
		const timer = setTimeout(
			() => this.#connectWhenBound(launch, deadline),
			RELAY_ENDPOINT_POLL_MS,
		);
		timer.unref?.();
	}

	get killed() {
		return this.#killed;
	}

	get exitCode() {
		return this.#exitCode;
	}

	get signalCode() {
		return this.#signalCode;
	}

	kill(signal) {
		if (typeof signal !== "string" || !supportedSignals.has(signal)) {
			throw relayProtocolError("signal_invalid");
		}
		if (this.#terminalEventDelivered || this.#killed) return false;
		this.#killed = true;
		this.#requestControl(RelayFrameKind.signal, { signal });
		return true;
	}

	on(event, listener) {
		this.#events.on(event, listener);
		return this;
	}

	once(event, listener) {
		this.#events.once(event, listener);
		return this;
	}

	off(event, listener) {
		this.#events.off(event, listener);
		return this;
	}

	#writeStdin(chunk, callback) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		if (bytes.length > MAX_PENDING_STDIN_BYTES) {
			callback(relayProtocolError("stdin_write_too_large"));
			return;
		}
		if (this.#state === "failed" || this.#terminalEventDelivered) {
			callback(relayProtocolError("stdin_after_terminal"));
			return;
		}
		if (this.#pendingWrite) {
			callback(relayProtocolError("stdin_write_overlap"));
			return;
		}
		this.#pendingWrite = {
			bytes,
			offset: 0,
			callback,
		};
		this.#sendNextStdinChunk();
	}

	#sendNextStdinChunk() {
		if (this.#state !== "ready" || !this.#pendingWrite || this.#pendingStdinSequence) return;
		if (this.#pendingWrite.offset === this.#pendingWrite.bytes.length) {
			const { callback } = this.#pendingWrite;
			this.#pendingWrite = undefined;
			callback();
			return;
		}
		const end = Math.min(
			this.#pendingWrite.offset + MAX_RELAY_STREAM_BYTES,
			this.#pendingWrite.bytes.length,
		);
		const payload = this.#pendingWrite.bytes.subarray(this.#pendingWrite.offset, end);
		this.#pendingWrite.offset = end;
		this.#pendingStdinSequence = this.#send(RelayFrameKind.stdin, {}, payload);
	}

	#finishStdin(callback) {
		if (this.#state === "failed" || this.#terminalEventDelivered) {
			callback(relayProtocolError("stdin_eof_after_terminal"));
			return;
		}
		this.#pendingFinal = callback;
		this.#sendStdinEof();
	}

	#sendStdinEof() {
		if (this.#state !== "ready" || !this.#pendingFinal || this.#pendingEofSequence) return;
		this.#pendingEofSequence = this.#send(RelayFrameKind.stdinEof);
	}

	#requestControl(kind, metadata) {
		if (this.#terminalEventDelivered || this.#state === "failed") return;
		if (this.#state !== "ready") {
			if (this.#pendingControl) return;
			this.#pendingControl = { kind, metadata };
			return;
		}
		this.#sendControl(kind, metadata);
	}

	#sendControl(kind, metadata) {
		if (this.#pendingControlSequence) return;
		this.#pendingControlKind = kind;
		this.#pendingControlSequence = this.#send(kind, metadata);
	}

	#resumeStdout() {
		if (!this.#pendingStdoutSequence || this.#state !== "ready") return;
		const ackSequence = this.#pendingStdoutSequence;
		this.#pendingStdoutSequence = undefined;
		this.#send(RelayFrameKind.stdoutAck, { ackSequence });
	}

	#send(kind, metadata = {}, payload) {
		const sequence = ++this.#sendSequence;
		this.#socket.write(
			encodeRelayFrame({
				kind,
				sequence,
				identity: this.#configuration.identity,
				metadata,
				payload,
			}),
		);
		return sequence;
	}

	#receive(frame) {
		if (this.#state === "failed" || this.#terminalEventDelivered) return;
		if (!relayIdentityMatches(frame.identity, this.#configuration.identity)) {
			throw relayProtocolError("stale_identity");
		}
		if (frame.sequence !== this.#receiveSequence + 1) {
			throw relayProtocolError("receive_sequence_gap");
		}
		this.#receiveSequence = frame.sequence;
		switch (frame.kind) {
			case RelayFrameKind.ready:
				this.#receiveReady(frame);
				break;
			case RelayFrameKind.stdinAck:
				this.#receiveStdinAck(frame);
				break;
			case RelayFrameKind.stdinEofAck:
				this.#receiveStdinEofAck(frame);
				break;
			case RelayFrameKind.stdout:
				this.#receiveStdout(frame);
				break;
			case RelayFrameKind.stdoutEof:
				this.#receiveStdoutEof(frame);
				break;
			case RelayFrameKind.signalAck:
			case RelayFrameKind.abortAck:
				this.#receiveControlAck(frame);
				break;
			case RelayFrameKind.exit:
				this.#receiveExit(frame);
				break;
			case RelayFrameKind.error:
				if (
					typeof frame.metadata.reason !== "string" ||
					!/^[-a-z0-9_]{1,64}$/u.test(frame.metadata.reason)
				) {
					throw relayProtocolError("remote_error_invalid");
				}
				throw relayProtocolError(
					`remote_${frame.metadata.reason}`,
				);
			default:
				throw relayProtocolError("unexpected_frame_kind");
		}
	}

	#receiveReady(frame) {
		if (
			this.#state !== "connecting" ||
			frame.metadata.helloSequence !== this.#helloSequence ||
			!Number.isSafeInteger(frame.metadata.pid) ||
			frame.metadata.pid <= 1
		) {
			throw relayProtocolError("ready_invalid");
		}
		this.#state = "ready";
		this.#sendNextStdinChunk();
		this.#sendStdinEof();
		if (this.#pendingControl) {
			const pending = this.#pendingControl;
			this.#pendingControl = undefined;
			this.#sendControl(pending.kind, pending.metadata);
		}
	}

	#receiveControlAck(frame) {
		const expectedKind =
			this.#pendingControlKind === RelayFrameKind.signal
				? RelayFrameKind.signalAck
				: RelayFrameKind.abortAck;
		if (
			!this.#pendingControlSequence ||
			frame.kind !== expectedKind ||
			frame.metadata.ackSequence !== this.#pendingControlSequence
		) {
			throw relayProtocolError("control_ack_invalid");
		}
		this.#pendingControlSequence = undefined;
		this.#pendingControlKind = undefined;
	}

	#receiveStdinAck(frame) {
		if (
			!this.#pendingStdinSequence ||
			frame.metadata.ackSequence !== this.#pendingStdinSequence
		) {
			throw relayProtocolError("stdin_ack_invalid");
		}
		this.#pendingStdinSequence = undefined;
		this.#sendNextStdinChunk();
	}

	#receiveStdinEofAck(frame) {
		if (
			!this.#pendingEofSequence ||
			frame.metadata.ackSequence !== this.#pendingEofSequence
		) {
			throw relayProtocolError("stdin_eof_ack_invalid");
		}
		this.#pendingEofSequence = undefined;
		const callback = this.#pendingFinal;
		this.#pendingFinal = undefined;
		callback();
	}

	#receiveStdout(frame) {
		if (this.#state !== "ready" || this.#stdoutEnded || this.#pendingStdoutSequence) {
			throw relayProtocolError("stdout_flow_control_invalid");
		}
		this.#pendingStdoutSequence = frame.sequence;
		if (this.stdout.push(frame.payload)) this.#resumeStdout();
	}

	#receiveStdoutEof() {
		if (this.#state !== "ready" || this.#stdoutEnded || this.#pendingStdoutSequence) {
			throw relayProtocolError("stdout_eof_invalid");
		}
		this.#stdoutEnded = true;
		this.stdout.push(null);
	}

	#receiveExit(frame) {
		const { code, signal, stderrTruncated = false } = frame.metadata;
		const hasCode = code !== null;
		const hasSignal = signal !== null;
		if (
			!this.#stdoutEnded ||
			hasCode === hasSignal ||
			(code !== null && (!Number.isSafeInteger(code) || code < 0)) ||
			(signal !== null && (typeof signal !== "string" || !exitSignals.has(signal))) ||
			frame.payload.length > MAX_RELAY_STDERR_BYTES ||
			typeof stderrTruncated !== "boolean"
		) {
			throw relayProtocolError("exit_invalid");
		}
		this.#exitCode = code;
		this.#signalCode = signal;
		this.#terminalEventDelivered = true;
		this.#state = "exited";
		const pendingInputError = relayProtocolError("process_exited_before_stdin_ack");
		if (this.#pendingWrite) {
			const callback = this.#pendingWrite.callback;
			this.#pendingWrite = undefined;
			callback(pendingInputError);
		}
		if (this.#pendingFinal) {
			const callback = this.#pendingFinal;
			this.#pendingFinal = undefined;
			callback(pendingInputError);
		}
		this.#pendingStdinSequence = undefined;
		this.#pendingEofSequence = undefined;
		this.#pendingControl = undefined;
		this.#pendingControlSequence = undefined;
		this.#pendingControlKind = undefined;
		if (frame.payload.length > 0) {
			this.#configuration.onDiagnostic?.({
				stderrTail: frame.payload.toString("utf8"),
				stderrTruncated,
			});
		}
		this.#removeAbortListener();
		this.#events.emit("exit", code, signal);
	}

	#fail(reason) {
		if (this.#state === "failed" || this.#terminalEventDelivered) return;
		const error =
			reason instanceof Error ? reason : relayProtocolError("transport_failure");
		this.#state = "failed";
		this.#removeAbortListener();
		this.#socket?.destroy();
		if (this.#pendingWrite) {
			const callback = this.#pendingWrite.callback;
			this.#pendingWrite = undefined;
			callback(error);
		}
		if (this.#pendingFinal) {
			const callback = this.#pendingFinal;
			this.#pendingFinal = undefined;
			callback(error);
		}
		this.stdout.destroy(error);
		this.#events.emit("error", error);
	}

	#removeAbortListener() {
		if (this.#abortHandler) {
			this.#abortSignal?.removeEventListener("abort", this.#abortHandler);
			this.#abortHandler = undefined;
			this.#abortSignal = undefined;
		}
	}
}

export function createClaudeRelaySpawner(configuration) {
	const parsed = relayConfiguration(configuration);
	let consumed = false;
	return (options) => {
		if (consumed) throw relayProtocolError("relay_binding_already_consumed");
		consumed = true;
		return new RelaySpawnedProcess(parsed, options);
	};
}
