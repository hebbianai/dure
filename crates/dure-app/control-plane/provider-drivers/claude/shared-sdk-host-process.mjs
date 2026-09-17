import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";

export function sharedSdkHostProcessArguments(arguments_) {
	const values = new Map();
	for (let index = 0; index < arguments_.length; index += 2) {
		const key = arguments_[index];
		const value = arguments_[index + 1];
		if (!key?.startsWith("--") || value === undefined || values.has(key)) {
			throw new Error("dure_claude_shared_sdk_host_invalid_arguments");
		}
		values.set(key, value);
	}
	if (
		(values.size < 4 || values.size > 7) ||
		!["--capability-file", "--endpoint", "--host-generation", "--state-dir"].every(
			(key) => values.has(key),
		) ||
		[...values.keys()].some(
			(key) =>
				![
					"--capability-file",
					"--endpoint",
					"--host-generation",
					"--owner-lifetime",
					"--retired-identities-file",
					"--runtime-root",
					"--state-dir",
				].includes(key),
		)
	) {
		throw new Error("dure_claude_shared_sdk_host_invalid_arguments");
	}
	if (values.has("--owner-lifetime") && values.get("--owner-lifetime") !== "stdin") {
		throw new Error("dure_claude_shared_sdk_host_invalid_arguments");
	}
	const stateDirectory = path.resolve(values.get("--state-dir"));
	const metadata = fs.lstatSync(stateDirectory);
	if (
		!metadata.isDirectory() ||
		metadata.isSymbolicLink() ||
		metadata.mode & 0o077 ||
		(typeof process.geteuid === "function" && metadata.uid !== process.geteuid())
	) {
		throw new Error("dure_claude_shared_sdk_host_unsafe_state_directory");
	}
	return Object.freeze({
		capabilityFile: path.resolve(values.get("--capability-file")),
		endpoint: path.resolve(values.get("--endpoint")),
		hostGeneration: values.get("--host-generation"),
		ownerLifetime: values.get("--owner-lifetime") ?? null,
		retiredIdentitiesFile: values.has("--retired-identities-file")
			? path.resolve(values.get("--retired-identities-file"))
			: null,
		runtimeRoot: values.has("--runtime-root")
			? path.resolve(values.get("--runtime-root"))
			: null,
		stateDirectory,
	});
}

function observeOwnerLifetime(ownerLifetime) {
	if (ownerLifetime !== "stdin") {
		return Object.freeze({ dispose() {}, ended: new Promise(() => {}) });
	}
	let resolve;
	const ended = new Promise((resolve_) => {
		resolve = resolve_;
	});
	const onOwnerLost = () => resolve();
	if (process.stdin.readableEnded || process.stdin.destroyed) {
		onOwnerLost();
	} else {
		process.stdin.once("end", onOwnerLost);
		process.stdin.once("close", onOwnerLost);
		process.stdin.once("error", onOwnerLost);
		process.stdin.resume();
	}
	return Object.freeze({
		dispose() {
			process.stdin.off("end", onOwnerLost);
			process.stdin.off("close", onOwnerLost);
			process.stdin.off("error", onOwnerLost);
			process.stdin.pause();
		},
		ended,
	});
}

export function readRetiredSdkHostIdentities(target) {
	if (!target) return [];
	const metadata = fs.lstatSync(target);
	if (
		!metadata.isFile() ||
		metadata.isSymbolicLink() ||
		metadata.mode & 0o077 ||
		metadata.size > 64 * 1024 ||
		(typeof process.geteuid === "function" && metadata.uid !== process.geteuid())
	) {
		throw new Error("dure_claude_shared_sdk_host_retired_identities_unsafe");
	}
	const identities = JSON.parse(fs.readFileSync(target, "utf8"));
	if (!Array.isArray(identities)) {
		throw new Error("dure_claude_shared_sdk_host_retired_identities_invalid");
	}
	return identities;
}

function atomicMarker(stateDirectory, value) {
	const target = path.join(stateDirectory, "host.json");
	const staging = path.join(stateDirectory, `.host.${process.pid}.tmp`);
	fs.writeFileSync(staging, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
	fs.renameSync(staging, target);
}

function cleanupHostStateDirectory(stateDirectory) {
	try {
		fs.unlinkSync(path.join(stateDirectory, "host.json"));
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
	fs.rmdirSync(stateDirectory);
}

export async function serveSharedSdkHostProcess(configuration) {
	const { fixture, options, sdk, server } = configuration;
	let markerSequence = 0;
	const writeMarker = () => {
		atomicMarker(options.stateDirectory, {
			activeResources: process.getActiveResourcesInfo(),
			cpuUsage: process.cpuUsage(),
			fixture,
			hostGeneration: options.hostGeneration,
			memoryUsage: process.memoryUsage(),
			parentPid: process.ppid,
			pid: process.pid,
			queryCount: server.host.queryCount,
			role: "dure-claude-sdk-host",
			runtime: configuration.runtime ?? null,
			sdk,
			sequence: ++markerSequence,
			state: server.host.state,
		});
	};
	const stop = () => server.close();
	const ownerLifetime = observeOwnerLifetime(options.ownerLifetime);
	process.on("SIGUSR1", writeMarker);
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);
	writeMarker();
	try {
		const outcome = await Promise.race([
			server.closed.then(() => "server_closed"),
			once(process, "beforeExit").then(() => "before_exit"),
			ownerLifetime.ended.then(() => "owner_lost"),
		]);
		if (outcome === "owner_lost") {
			await Promise.race([server.host.releaseOwner(), server.closed]);
			await server.close();
		}
	} finally {
		process.off("SIGUSR1", writeMarker);
		process.off("SIGTERM", stop);
		process.off("SIGINT", stop);
		ownerLifetime.dispose();
		cleanupHostStateDirectory(options.stateDirectory);
	}
}
