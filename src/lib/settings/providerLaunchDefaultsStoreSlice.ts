import type { StoreApi } from "zustand";
import type { DureBackendIdentity } from "@/lib/ipc/dureBackend";
import type { ProviderLaunchDefaultsDocumentV1 } from "@/lib/settings/providerLaunchDefaultsContract";
import { type Agent, PROVIDERS, type Provider } from "@/types";

export interface ProviderLaunchDefaultsStoreSlice {
	/** Runtime projection of the backend provider defaults authority. */
	skipPermissions: Partial<Record<Provider, boolean>>;
	providerLaunchDefaults: ProviderLaunchDefaultsDocumentV1 | null;
	providerLaunchDefaultsBackend: DureBackendIdentity | null;
	providerLaunchDefaultsProfileId: string | null;
	providerLaunchDefaultsError: string | null;
	/** Retained only until a backend put-if-absent receipt confirms migration. */
	legacySkipPermissions?: Partial<Record<Provider, boolean>>;
	applyProviderLaunchDefaultsProjection: (
		document: ProviderLaunchDefaultsDocumentV1,
		backend: DureBackendIdentity,
		profileId: string,
	) => void;
}

type ProjectionHostState = ProviderLaunchDefaultsStoreSlice & {
	agents: Agent[];
};

export function createProviderLaunchDefaultsStoreSlice<
	State extends ProjectionHostState,
>(set: StoreApi<State>["setState"]): ProviderLaunchDefaultsStoreSlice {
	return {
		skipPermissions: {},
		providerLaunchDefaults: null,
		providerLaunchDefaultsBackend: null,
		providerLaunchDefaultsProfileId: null,
		providerLaunchDefaultsError: null,
		legacySkipPermissions: undefined,
		applyProviderLaunchDefaultsProjection: (document, backend, profileId) =>
			set((state) => {
				const sameAuthority =
					state.providerLaunchDefaultsProfileId === profileId &&
					state.providerLaunchDefaultsBackend?.id === backend.id &&
					state.providerLaunchDefaultsBackend.generation === backend.generation;
				if (
					sameAuthority &&
					state.providerLaunchDefaults &&
					document.revision < state.providerLaunchDefaults.revision
				) {
					return state;
				}
				const firstProjection = state.providerLaunchDefaults === null;
				const inheritedBeforeMigration = state.legacySkipPermissions ?? {};
				const skipPermissions = Object.fromEntries(
					Object.keys(PROVIDERS).map((provider) => [
						provider,
						document.defaults[provider]?.permissionMode === "bypass_approvals",
					]),
				) as Partial<Record<Provider, boolean>>;
				return {
					providerLaunchDefaults: document,
					providerLaunchDefaultsBackend: backend,
					providerLaunchDefaultsProfileId: profileId,
					providerLaunchDefaultsError: null,
					skipPermissions,
					legacySkipPermissions: undefined,
					agents: firstProjection
						? state.agents.map((agent) =>
								agent.skipPermissions === undefined
									? {
											...agent,
											skipPermissions: Boolean(
												inheritedBeforeMigration[agent.provider],
											),
										}
									: agent,
							)
						: state.agents,
				} as Partial<State>;
			}),
	};
}
