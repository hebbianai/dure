import type {
	Provider as CanonicalProvider,
	ProviderSpec as CanonicalProviderSpec,
	TerminalEnvironment as CanonicalTerminalEnvironment,
} from "@/lib/agents/providerContracts";

/** @deprecated Import `Provider` from `@/types` instead. */
export type Provider = CanonicalProvider;
/** @deprecated Import `ProviderSpec` from `@/types` instead. */
export type ProviderSpec = CanonicalProviderSpec;
/** @deprecated Import `TerminalEnvironment` from `@/types` instead. */
export type TerminalEnvironment = CanonicalTerminalEnvironment;
