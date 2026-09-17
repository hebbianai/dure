import type { Provider } from "@/types";

export type ManagedConversationIdentitySource =
	| "host_rollout"
	| "session_start_hook";

interface ManagedProviderCapabilities {
	conversationIdentitySource?: ManagedConversationIdentitySource;
	conversationIdentityInspection?: true;
	standalonePromotion?: true;
}

/** One provider-adapter table for managed runtime behavior. Missing providers
 * keep provider-neutral PTY semantics without acquiring structured promises. */
const MANAGED_PROVIDER_CAPABILITIES: Partial<
	Record<Provider, ManagedProviderCapabilities>
> = {
	codex: {
		conversationIdentitySource: "host_rollout",
		conversationIdentityInspection: true,
		standalonePromotion: true,
	},
	claude: {
		conversationIdentitySource: "session_start_hook",
		conversationIdentityInspection: true,
		standalonePromotion: true,
	},
};

export function managedConversationIdentitySource(
	provider: Provider,
): ManagedConversationIdentitySource | undefined {
	return MANAGED_PROVIDER_CAPABILITIES[provider]?.conversationIdentitySource;
}

export function supportsManagedConversationIdentityInspection(
	provider: Provider,
): boolean {
	return (
		MANAGED_PROVIDER_CAPABILITIES[provider]?.conversationIdentityInspection ===
		true
	);
}

export function supportsStandaloneManagedPromotion(
	provider: Provider,
): boolean {
	return MANAGED_PROVIDER_CAPABILITIES[provider]?.standalonePromotion === true;
}
