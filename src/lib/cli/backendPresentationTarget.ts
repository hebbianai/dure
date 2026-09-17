import { isRecord } from "@/lib/payloadGuards";
import type { SshHostConfig } from "@/types";

const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,511}$/;

export interface SshBackendPresentationTarget {
	source: "ssh";
	hostId: string;
	remote: { host: string; port: number; user: string };
}

export type BackendPresentationTarget =
	| { source: "local"; hostId: "local" }
	| SshBackendPresentationTarget;

type PresentationTargetFailure = (code: string, message: string) => never;

function token(
	value: unknown,
	label: string,
	fail: PresentationTargetFailure,
): string {
	if (typeof value !== "string" || !SAFE_TOKEN.test(value)) {
		fail("invalid_request", `${label} is invalid`);
	}
	return value;
}

/** Parses the transport coordinates supplied by a backend profile once at
 * the app-control boundary. Downstream presentation code receives only this
 * normalized execution target. */
export function parseBackendPresentationTarget(
	value: {
		source?: unknown;
		hostId?: unknown;
		remote?: unknown;
	},
	fail: PresentationTargetFailure,
): BackendPresentationTarget {
	if (value.source === "local") {
		if (value.hostId !== "local" || value.remote !== undefined) {
			fail("invalid_request", "backend source identity is inconsistent");
		}
		return { source: "local", hostId: "local" };
	}
	if (value.source !== "ssh" || value.hostId === "local") {
		fail("invalid_request", "backend source identity is inconsistent");
	}
	if (!isRecord(value.remote)) {
		fail("invalid_request", "remote backend identity is invalid");
	}
	const port = value.remote.port;
	if (!Number.isInteger(port) || Number(port) < 1 || Number(port) > 65_535) {
		fail("invalid_request", "remote.port is invalid");
	}
	return {
		source: "ssh",
		hostId: token(value.hostId, "hostId", fail),
		remote: {
			host: token(value.remote.host, "remote.host", fail),
			port: Number(port),
			user: token(value.remote.user, "remote.user", fail),
		},
	};
}

/** Resolves backend transport coordinates to exactly one registered SSH host.
 * An exact id may be used only when its coordinates still agree; otherwise a
 * unique coordinate match is required. */
export function resolveBackendPresentationSshHost(
	target: SshBackendPresentationTarget,
	hosts: readonly SshHostConfig[],
	fail: PresentationTargetFailure,
): SshHostConfig {
	const sameTarget = (host: SshHostConfig) =>
		host.host === target.remote.host &&
		host.port === target.remote.port &&
		host.user === target.remote.user;
	const byId = hosts.find((host) => host.id === target.hostId);
	if (byId) {
		if (!sameTarget(byId)) {
			fail(
				"client_backend_host_mismatch",
				"backend profile and registered SSH host disagree",
			);
		}
		return byId;
	}
	const matches = hosts.filter(sameTarget);
	if (matches.length !== 1) {
		fail(
			matches.length === 0
				? "client_backend_host_unmapped"
				: "client_backend_host_ambiguous",
			"backend profile does not map to one registered SSH host",
		);
	}
	return matches[0];
}
