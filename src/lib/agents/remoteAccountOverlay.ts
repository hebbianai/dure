import {
	assertCredentialOverlayVersion,
	credentialOverlayMinimumVersion,
} from "@/lib/agents/providerCredentials";
import { providerExecutable } from "@/lib/agents/providerPreflight";
import {
	providerCredentialCapability,
	remoteAccountDir,
	remoteLoginCmd,
} from "@/lib/agents/providers";
import {
	hostToOpts,
	type RemoteAccountOverlayReceipt,
	sshCopyAccount,
	sshExecOnce,
	sshPrepareAccountOverlay,
} from "@/lib/ipc";
import { shellQuote } from "@/lib/platform/shell";
import type { AccountProfile, Provider, SshHostConfig } from "@/types";

class RemoteProviderPreflightError extends Error {
	readonly code = "remote_provider_preflight_failed";

	constructor(
		readonly provider: Provider,
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "RemoteProviderPreflightError";
	}
}

export interface RemoteAccountLaunchPreflight {
	version: string;
	overlay?: RemoteAccountOverlayReceipt;
}

export interface RemoteAccountLaunchPreflightOptions {
	requireCredential?: boolean;
	remoteProfileDirectory?: string;
	beforeOverlay?: () => Promise<void>;
}

/** Classify the existing adapter refusal, never a generic SSH/launch failure. */
export function isRemoteCredentialUnavailable(error: unknown): boolean {
	if (error && typeof error === "object" && "code" in error) {
		return error.code === "remote_credential_unavailable";
	}
	const message = error instanceof Error ? error.message : String(error);
	return /^(?:Error: )?remote_credential_unavailable(?::|$)/.test(message);
}

/** Login provisions the same profile but cannot require its missing credential. */
export async function prepareRemoteAccountLogin(
	host: SshHostConfig,
	cwd: string,
	account: AccountProfile,
): Promise<string> {
	await preflightRemoteAccountLaunch(host, account.provider, cwd, account, {
		requireCredential: false,
	});
	return remoteLoginCmd(account);
}

/** Verify the provider and reviewed overlay version before any remote profile
 * mutation. Provisioning is then performed by the backend-owned shell program.
 * Callers must finish this entire preflight before stopping a live session. */
export async function preflightRemoteAccountLaunch(
	host: SshHostConfig,
	provider: Provider,
	cwd: string,
	account?: AccountProfile,
	options: RemoteAccountLaunchPreflightOptions = {},
): Promise<RemoteAccountLaunchPreflight> {
	const {
		requireCredential = true,
		remoteProfileDirectory,
		beforeOverlay,
	} = options;
	const profileDirectory =
		remoteProfileDirectory ?? (account ? remoteAccountDir(account) : undefined);
	const needsVersion =
		profileDirectory && credentialOverlayMinimumVersion(provider);
	const executable = providerExecutable(provider);
	const inner = [
		`cd ${shellQuote(cwd)}`,
		`if ! command -v ${shellQuote(executable)} >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then NVM_DIR="$HOME/.nvm"; export NVM_DIR; . "$NVM_DIR/nvm.sh"; nvm use --silent node >/dev/null; fi`,
		`command -v ${shellQuote(executable)} >/dev/null`,
		...(needsVersion ? [`${shellQuote(executable)} --version`] : []),
	].join(" && ");
	// Match the managed launch's non-interactive shell. The explicit NVM fallback
	// above supplies its PATH without Bash job-control warnings or rc-file output.
	const command = `remote_shell=\${SHELL:-/bin/sh}; "$remote_shell" -lc ${shellQuote(inner)}`;
	const result = await sshExecOnce(hostToOpts(host), command);
	const diagnostic = `${result.stdout}\n${result.stderr}`.trim();
	if (result.code !== 0) {
		throw new RemoteProviderPreflightError(
			provider,
			result.code,
			diagnostic || `${provider} is unavailable on the remote host`,
		);
	}

	const version = needsVersion ? diagnostic : "";
	if (
		!profileDirectory ||
		providerCredentialCapability(provider).credentialSelection !==
			"per_process_credential_overlay"
	) {
		return { version };
	}
	assertCredentialOverlayVersion(provider, version);
	await beforeOverlay?.();
	const overlay = await sshPrepareAccountOverlay(
		hostToOpts(host),
		provider,
		profileDirectory,
		requireCredential,
	).catch(async (error: unknown) => {
		if (
			!requireCredential ||
			!isRemoteCredentialUnavailable(error) ||
			!account ||
			account.provider !== provider ||
			profileDirectory !== remoteAccountDir(account)
		) {
			throw error;
		}
		await beforeOverlay?.();
		await sshCopyAccount(
			hostToOpts(host),
			provider,
			account.dir,
			profileDirectory,
		);
		await beforeOverlay?.();
		return sshPrepareAccountOverlay(
			hostToOpts(host),
			provider,
			profileDirectory,
			true,
		);
	});
	return { version, overlay };
}
