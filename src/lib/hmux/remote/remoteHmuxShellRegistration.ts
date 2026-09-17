import {
	matchingRemoteHmuxHosts,
	type PlainInteractiveSshDestination,
} from "@/lib/hmux/remote/remoteHmuxShellRequest";
import { canonicalSshNetworkHost } from "@/lib/ssh/sshNetworkHost";
import type { SshConfigScan, SshHostConfig } from "@/types";

export type RemoteShellHostDraft = Pick<
	SshHostConfig,
	"name" | "host" | "port" | "user"
> & {
	auth: "auto";
};

/** Only explicit network destinations can become persistent auto-auth hosts.
 * Opaque aliases and ambiguous saved matches retain ordinary SSH behavior. */
export function remoteShellHostCandidate(
	hosts: readonly SshHostConfig[],
	destination: PlainInteractiveSshDestination,
	config: SshConfigScan,
): RemoteShellHostDraft | undefined {
	if (
		config.aliasInspection?.kind !== "complete" ||
		matchingRemoteHmuxHosts(hosts, destination).length !== 0 ||
		!destination.user ||
		!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}$/.test(destination.user) ||
		!Number.isInteger(destination.port) ||
		!destination.port ||
		destination.port < 1 ||
		destination.port > 65_535
	)
		return undefined;
	const token = destination.host.toLowerCase();
	if (
		hosts.some(
			(host) =>
				host.name.toLowerCase() === token ||
				host.sshConfigAlias?.toLowerCase() === token,
		) ||
		config.aliasInspection.aliases.some(
			(alias) => alias.toLowerCase() === token,
		)
	)
		return undefined;
	const host = canonicalSshNetworkHost(destination.host);
	if (!host) return undefined;
	const displayHost = host.includes(":") ? `[${host}]` : host;
	return {
		name: `${destination.user}@${displayHost}:${destination.port}`,
		host,
		port: destination.port,
		user: destination.user,
		auth: "auto",
	};
}
