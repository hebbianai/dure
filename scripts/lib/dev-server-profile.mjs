import {
	existsSync,
	mkdirSync,
	readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	appControlDirectory,
	DEV_INSTANCE_ENV,
	resolveDevServer,
} from "./app-channel.mjs";
import { writeExclusiveFile } from "./durable-file.mjs";

export const DEV_SERVER_PROFILE_SCHEMA_VERSION = 1;
export const DEV_SERVER_PROFILE_FILE = "dev-server-profile-v1.json";

export function devServerProfilePath(home, channel) {
	return join(appControlDirectory(home, channel), DEV_SERVER_PROFILE_FILE);
}

function profileError(pathname, message) {
	return new Error(`invalid development server profile ${pathname}: ${message}`);
}

function parseProfile(pathname, source, { channel, worktreeRoot }) {
	let profile;
	try {
		profile = JSON.parse(source);
	} catch (error) {
		throw profileError(pathname, `malformed JSON (${error.message})`);
	}
	if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
		throw profileError(pathname, "expected an object");
	}
	if (profile.schemaVersion !== DEV_SERVER_PROFILE_SCHEMA_VERSION) {
		throw profileError(pathname, "unsupported schemaVersion");
	}
	if (profile.channel !== channel) {
		throw profileError(pathname, "channel does not match its control directory");
	}
	if (profile.worktreeRoot !== worktreeRoot) {
		throw profileError(pathname, "worktree root does not match the current checkout");
	}
	if (typeof profile.host !== "string" || !Number.isInteger(profile.port)) {
		throw profileError(pathname, "host and port must be explicit");
	}

	let server;
	try {
		server = resolveDevServer(worktreeRoot, String(profile.port), profile.host);
	} catch (error) {
		throw profileError(pathname, error.message);
	}
	return { ...server, source: "channel-profile" };
}

export function readDevServerProfile({ home, channel, worktreeRoot }) {
	const pathname = devServerProfilePath(home, channel);
	if (!existsSync(pathname)) return undefined;
	return parseProfile(pathname, readFileSync(pathname, "utf8"), {
		channel,
		worktreeRoot,
	});
}

export function selectDevServerProfile({
	home,
	channel,
	worktreeRoot,
	portOverride,
	hostOverride,
}) {
	return (
		readDevServerProfile({ home, channel, worktreeRoot }) ??
		resolveDevServer(worktreeRoot, portOverride, hostOverride)
	);
}

export function resolveDevDeployServerProfile({
	home,
	channel,
	worktreeRoot,
	explicitPort,
	ambientPort,
}) {
	const persisted = readDevServerProfile({ home, channel, worktreeRoot });
	const explicit =
		explicitPort === undefined
			? undefined
			: resolveDevServer(worktreeRoot, String(explicitPort));
	if (persisted) {
		if (explicit && explicit.port !== persisted.port) {
			throw new Error(
				`explicit port ${explicit.port} conflicts with persisted development server profile ${persisted.port}`,
			);
		}
		return persisted;
	}
	return (
		explicit ??
		resolveDevServer(
			worktreeRoot,
			ambientPort === undefined ? undefined : String(ambientPort),
		)
	);
}

export function persistDevServerProfile({
	home,
	channel,
	worktreeRoot,
	devServer,
}) {
	const pathname = devServerProfilePath(home, channel);
	const selected = resolveDevServer(
		worktreeRoot,
		String(devServer.port),
		devServer.host,
	);
	const existing = readDevServerProfile({ home, channel, worktreeRoot });
	if (existing) {
		if (existing.host !== selected.host || existing.port !== selected.port) {
			throw new Error(
				`development channel ${channel} is already pinned to ${existing.origin}; ` +
					`use a new ${DEV_INSTANCE_ENV} for a different origin`,
			);
		}
		return existing;
	}

	mkdirSync(dirname(pathname), { recursive: true, mode: 0o700 });
	try {
		writeExclusiveFile(
			pathname,
			`${JSON.stringify({
				schemaVersion: DEV_SERVER_PROFILE_SCHEMA_VERSION,
				channel,
				worktreeRoot,
				host: selected.host,
				port: selected.port,
			})}\n`,
		);
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
	}

	const persisted = readDevServerProfile({ home, channel, worktreeRoot });
	if (
		persisted.host !== selected.host ||
		persisted.port !== selected.port
	) {
		throw new Error(
			`development channel ${channel} was concurrently pinned to ${persisted.origin}; ` +
				`refusing to launch ${selected.origin}`,
		);
	}
	return persisted;
}
