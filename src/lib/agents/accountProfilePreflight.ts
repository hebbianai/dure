import {
	assertCredentialOverlayVersion,
	credentialOverlayMinimumVersion,
} from "@/lib/agents/providerCredentials";
import {
	ProviderPreflightError,
	providerExecutable,
} from "@/lib/agents/providerPreflight";
import { homeDir, providerPreflight } from "@/lib/ipc";
import type { Provider } from "@/types";

/** Probe only when account isolation depends on a minimum CLI version. */
export async function preflightAccountProfileCreation(
	provider: Provider,
): Promise<void> {
	if (!credentialOverlayMinimumVersion(provider)) return;
	const cwd = await homeDir();
	const result = await providerPreflight({
		provider,
		command: providerExecutable(provider),
		cwd,
	});
	if (!result.ready) throw new ProviderPreflightError(result);
	assertCredentialOverlayVersion(provider, result.version);
}
