import { canonicalSshNetworkHost } from "@/lib/ssh/sshNetworkHost";
import type { SshHostConfig } from "@/types";
import {
	type PlainInteractiveSshDestination,
	parsePlainInteractiveSsh,
} from "../../../../cli/lib/ssh-command.mjs";

export type { PlainInteractiveSshDestination } from "../../../../cli/lib/ssh-command.mjs";

const SAFE_ID = /^[A-Za-z0-9._:+-]{1,256}$/;
const MAX_SSH_ARGV = 128;
const MAX_SSH_ARG = 4_096;

export interface RemoteShellRequest {
	sourceSessionId: string;
	sourceWorkspaceId: string;
	argv: string[];
	destination: PlainInteractiveSshDestination;
	initialColumns: number;
	initialRows: number;
}

export class RemoteHmuxShellRequestError extends Error {
	readonly code = "invalid_request";
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: undefined;
}

function terminalDimension(value: unknown, fallback: number): number {
	return Number.isInteger(value) &&
		(value as number) >= 1 &&
		(value as number) <= 1_000
		? (value as number)
		: fallback;
}

export function parseRemoteHmuxShellRequest(
	params: Record<string, unknown>,
): RemoteShellRequest {
	const sourceSessionId = String(params.sourceSessionId ?? "").trim();
	const sourceWorkspaceId = String(params.sourceWorkspaceId ?? "").trim();
	const destination = recordOf(params.destination);
	const host = String(destination?.host ?? "").trim();
	const user =
		destination?.user === undefined
			? undefined
			: String(destination.user).trim();
	const port =
		destination?.port === undefined ? undefined : Number(destination.port);
	const argv = Array.isArray(params.argv) ? params.argv : [];
	if (
		!SAFE_ID.test(sourceSessionId) ||
		!SAFE_ID.test(sourceWorkspaceId) ||
		host.length === 0 ||
		host.length > 255 ||
		/\s|\0|\//.test(host) ||
		(user !== undefined &&
			(user.length === 0 || user.length > 255 || /\s|\0/.test(user))) ||
		(port !== undefined &&
			(!Number.isInteger(port) || port < 1 || port > 65_535)) ||
		argv.length === 0 ||
		argv.length > MAX_SSH_ARGV ||
		!argv.every(
			(value) =>
				typeof value === "string" &&
				value.length <= MAX_SSH_ARG &&
				!value.includes("\0"),
		)
	) {
		throw new RemoteHmuxShellRequestError(
			"remote Hmux handoff requires a bounded plain interactive SSH request",
		);
	}
	// The CLI's projection is an equality check, not a second destination
	// authority. Direct HTTP callers must obey the same plain-login grammar.
	const parsed = parsePlainInteractiveSsh(argv);
	if (
		parsed.kind !== "handoff" ||
		parsed.destination.host !== host ||
		parsed.destination.user !== user ||
		parsed.destination.port !== port
	) {
		throw new RemoteHmuxShellRequestError(
			"remote Hmux handoff requires matching plain SSH argv and destination",
		);
	}
	return {
		sourceSessionId,
		sourceWorkspaceId,
		argv,
		destination: parsed.destination,
		initialColumns: terminalDimension(params.initialColumns, 120),
		initialRows: terminalDimension(params.initialRows, 30),
	};
}

/** A plain destination can select only one registered Dure host. An explicit
 * user/port is an exact fence; a registered display name may imply its saved
 * user/port, while a literal network address without `-p` means port 22. */
export function matchingRemoteHmuxHosts(
	hosts: readonly SshHostConfig[],
	destination: PlainInteractiveSshDestination,
): SshHostConfig[] {
	const networkHost = canonicalSshNetworkHost(destination.host);
	return hosts.filter((candidate) => {
		const byName = candidate.name === destination.host;
		const byAddress =
			candidate.host === destination.host ||
			(networkHost !== undefined &&
				canonicalSshNetworkHost(candidate.host) === networkHost);
		if (!byName && !byAddress) return false;
		if (destination.user !== undefined && destination.user !== candidate.user) {
			return false;
		}
		if (destination.port !== undefined && destination.port !== candidate.port) {
			return false;
		}
		return destination.port !== undefined || byName || candidate.port === 22;
	});
}

export function matchRemoteHmuxHost(
	hosts: readonly SshHostConfig[],
	destination: PlainInteractiveSshDestination,
): SshHostConfig | undefined {
	const matches = matchingRemoteHmuxHosts(hosts, destination);
	return matches.length === 1 ? matches[0] : undefined;
}
