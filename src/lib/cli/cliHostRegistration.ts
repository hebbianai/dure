import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { claimCliRequest } from "@/lib/cli/cliRequestBroker";
import { sshConfigHosts } from "@/lib/ipc";
import { sshConfigHostDraft } from "@/lib/ssh/sshConfigRegistration";
import { registerSshConfigHostDurably } from "@/lib/ssh/sshConfigRouteLifecycle";
import {
	createSshHostDurably,
	type SshHostRegistrationResult,
} from "@/lib/ssh/sshCredentialLifecycle";
import { canonicalSshNetworkHost } from "@/lib/ssh/sshNetworkHost";
import type { SshHostConfig } from "@/types";

const dependencies = {
	isMainWindow: () => getCurrentWebviewWindow().label === "main",
	claim: claimCliRequest,
	scan: sshConfigHosts,
	registerConfig: registerSshConfigHostDurably,
	create: createSshHostDurably,
};

export type CliHostRegistrationDependencies = typeof dependencies;

function invalid(message: string): never {
	throw Object.assign(new Error(message), { code: "invalid_request" });
}

function text(value: unknown, field: string, maximum = 512): string {
	if (
		typeof value !== "string" ||
		!value.trim() ||
		value.length > maximum ||
		[...value].some((character) => {
			const code = character.charCodeAt(0);
			return code < 32 || code === 127;
		})
	)
		invalid(`${field} must be a nonempty bounded string`);
	return value.trim();
}

function publicHost(host: SshHostConfig) {
	return {
		id: host.id,
		name: host.name,
		host: host.host,
		port: host.port,
		user: host.user,
		auth: host.auth,
		sshConfigAlias: host.sshConfigAlias,
		keyPath: host.keyPath,
	};
}

/** CLI and GUI registration share the durable Host and credential lifecycle. */
export async function handleCliHostRegistration(
	params: Record<string, unknown>,
	reqId: string,
	deps: CliHostRegistrationDependencies = dependencies,
) {
	if (!deps.isMainWindow() || !(await deps.claim(reqId))) return null;
	try {
		const fields = new Set([
			"sshConfigAlias",
			"host",
			"user",
			"port",
			"keyPath",
			"name",
		]);
		if (Object.keys(params).some((key) => !fields.has(key)))
			invalid("Unsupported SSH host field");
		const name =
			params.name === undefined ? undefined : text(params.name, "name");
		let registration: SshHostRegistrationResult;
		if (params.sshConfigAlias !== undefined) {
			if (
				["host", "user", "port", "keyPath"].some(
					(key) => params[key] !== undefined,
				)
			) {
				invalid(
					"Choose an SSH config alias or explicit connection fields, not both",
				);
			}
			const alias = text(params.sshConfigAlias, "sshConfigAlias");
			const scan = await deps.scan();
			const configured = scan.files
				.flatMap((file) => file.hosts)
				.find((host) => host.alias.toLowerCase() === alias.toLowerCase());
			if (!configured) {
				throw Object.assign(
					new Error(`SSH config alias ${alias} was not found`),
					{
						code: "ssh_config_host_not_found",
					},
				);
			}
			const draft = sshConfigHostDraft(configured, scan.defaultUser);
			text(draft.user, "user");
			registration = await deps.registerConfig({
				...draft,
				name: name ?? draft.name,
			});
		} else {
			const inputHost = text(params.host, "host");
			const host =
				canonicalSshNetworkHost(inputHost) ??
				(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(inputHost)
					? inputHost.toLowerCase()
					: undefined);
			if (!host) invalid("host must be a hostname or IP address");
			const user = text(params.user, "user");
			if (user.startsWith("-") || /\s/.test(user))
				invalid("user must be an SSH account name");
			const port = params.port ?? 22;
			if (
				typeof port !== "number" ||
				!Number.isInteger(port) ||
				port < 1 ||
				port > 65535
			) {
				invalid("port must be an integer from 1 to 65535");
			}
			const keyPath =
				params.keyPath === undefined
					? undefined
					: text(params.keyPath, "keyPath", 4096);
			registration = await deps.create({
				name: name ?? `${user}@${host}`,
				host,
				user,
				port,
				auth: keyPath ? "key" : "auto",
				keyPath,
			});
		}
		return {
			ok: true,
			registration: {
				host: publicHost(registration.host),
				created: registration.created,
				persisted: true,
			},
		};
	} catch (error) {
		return {
			ok: false,
			error: {
				code:
					error && typeof error === "object" && "code" in error
						? String(error.code)
						: "ssh_host_add_failed",
				message: error instanceof Error ? error.message : String(error),
			},
		};
	}
}
