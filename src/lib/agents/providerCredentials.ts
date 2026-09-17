import { PROVIDERS, type Provider } from "@/types";

export type ProviderCredentialAdapterCapability =
	| {
			credentialSelection: "runtime_default";
			stateRoot: "provider_default";
			injectionMode: "runtime_default";
			concurrentDifferentCredentials: false;
	  }
	| {
			credentialSelection: "legacy_config_directory_alias";
			stateRoot: "credential_directory";
			environmentVariable: string;
			injectionMode: "per_process";
			concurrentDifferentCredentials: true;
	  }
	| {
			/** Thin credential dir: the account dir holds only credential material
			 * and spawn-synced replace-write state as real files. Reviewed state
			 * directories use canonical symlinks, append history uses a hard link,
			 * while provider-specific databases use their reviewed canonical
			 * state root directly. The env var is still injected
			 * per-process, so concurrent agents on different accounts stay safe —
			 * unlike competitor-style global auth-pointer swapping. */
			credentialSelection: "per_process_credential_overlay";
			stateRoot: "shared_canonical_overlay";
			environmentVariable: string;
			injectionMode: "per_process";
			concurrentDifferentCredentials: true;
	  };

const OVERLAY_ENVIRONMENT_DEFAULTS: Partial<Record<Provider, string>> = {
	codex: "CODEX_HOME",
	claude: "CLAUDE_CONFIG_DIR",
};

/**
 * Authentication selection and provider state storage are separate adapter
 * concerns. Codex and Claude accounts use the overlay adapter: a per-account
 * state root with private credential material, an allowlisted canonical state
 * view, and spawn-synced config.
 * Competitor-style global auth replacement
 * stays rejected — it is process-global and breaks concurrent accounts.
 */
export function providerCredentialCapability(
	provider: Provider,
): ProviderCredentialAdapterCapability {
	const environmentVariable = PROVIDERS[provider].configEnv;
	const overlayEnvironment = OVERLAY_ENVIRONMENT_DEFAULTS[provider];
	if (overlayEnvironment) {
		return {
			credentialSelection: "per_process_credential_overlay",
			stateRoot: "shared_canonical_overlay",
			environmentVariable: environmentVariable ?? overlayEnvironment,
			injectionMode: "per_process",
			concurrentDifferentCredentials: true,
		};
	}
	return environmentVariable
		? {
				credentialSelection: "legacy_config_directory_alias",
				stateRoot: "credential_directory",
				environmentVariable,
				injectionMode: "per_process",
				concurrentDifferentCredentials: true,
			}
		: {
				credentialSelection: "runtime_default",
				stateRoot: "provider_default",
				injectionMode: "runtime_default",
				concurrentDifferentCredentials: false,
			};
}

/** Account profiles (add/switch/per-agent binding) are supported by every
 * per-process adapter — both the legacy whole-directory alias and the shared
 * canonical overlay. Never by global-pointer or runtime-default adapters. */
export function providerSupportsAccountProfiles(provider: Provider): boolean {
	const selection = providerCredentialCapability(provider).credentialSelection;
	return (
		selection === "legacy_config_directory_alias" ||
		selection === "per_process_credential_overlay"
	);
}

export class ProviderCredentialUnsupportedError extends Error {
	readonly code = "credential_alias_unsupported";

	constructor(readonly provider: Provider) {
		super(
			`${PROVIDERS[provider].label} does not support safe per-process credential aliases; the runtime-user canonical home must be used`,
		);
		this.name = "ProviderCredentialUnsupportedError";
	}
}

type SemanticVersion = readonly [number, number, number];

const MINIMUM_OVERLAY_VERSIONS: Partial<Record<Provider, SemanticVersion>> = {
	claude: [2, 1, 212],
};

export function credentialOverlayMinimumVersion(
	provider: Provider,
): SemanticVersion | undefined {
	return MINIMUM_OVERLAY_VERSIONS[provider];
}

export class ProviderCredentialVersionUnsupportedError extends Error {
	readonly code = "credential_overlay_version_unsupported";

	constructor(
		readonly provider: Provider,
		readonly version: string | undefined,
		readonly minimumVersion: SemanticVersion,
	) {
		super(
			`${PROVIDERS[provider].label} account overlays require ${minimumVersion.join(".")} or newer; detected ${version ?? "an unknown version"}`,
		);
		this.name = "ProviderCredentialVersionUnsupportedError";
	}
}

function parsedSemanticVersion(
	version: string | undefined,
): [number, number, number] | undefined {
	const match = version?.match(/(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:\s|$)/);
	if (!match) return undefined;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Claude's reviewed macOS credential boundary is the config-root-scoped
 * Keychain behavior measured on 2.1.212. Older/unknown CLIs must not silently
 * fall back to a process-global credential while an account profile is active. */
export function assertCredentialOverlayVersion(
	provider: Provider,
	version: string | undefined,
): void {
	const minimum = credentialOverlayMinimumVersion(provider);
	if (!minimum) return;
	const parsed = parsedSemanticVersion(version);
	const comparison = parsed
		? parsed[0] - minimum[0] || parsed[1] - minimum[1] || parsed[2] - minimum[2]
		: -1;
	if (comparison < 0) {
		throw new ProviderCredentialVersionUnsupportedError(
			provider,
			version,
			minimum,
		);
	}
}

export class ConversationIdentityRequiredError extends Error {
	readonly code = "conversation_identity_required";

	constructor(readonly provider: Provider) {
		super(
			`${PROVIDERS[provider].label} credential changes require an explicit current conversation id`,
		);
		this.name = "ConversationIdentityRequiredError";
	}
}

/** A credential migration is stricter than an ordinary manual "continue".
 * It must never infer provider-native identity through `--last`. Any
 * per-process adapter qualifies (alias or overlay) — a running process never
 * changes its credential cache, so the restart + explicit id contract stays. */
export function assertCredentialMigrationSupported(
	provider: Provider,
	conversationId: string | null | undefined,
): asserts conversationId is string {
	if (!providerSupportsAccountProfiles(provider)) {
		throw new ProviderCredentialUnsupportedError(provider);
	}
	if (!conversationId?.trim()) {
		throw new ConversationIdentityRequiredError(provider);
	}
}
