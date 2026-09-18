// Account-profile store slice — provider credential profiles, the per-provider
// active account, and auto-switch settings.
// Extracted from store.ts as a composition slice (precedent:
// sessionRuntimeStoreSlice); implementations moved verbatim so update and
// no-op semantics are unchanged. Running Agent credentials are backend-owned
// runtime transitions and are intentionally absent from this settings slice.
import { nanoid } from "nanoid";
import {
	ProviderCredentialUnsupportedError,
	providerSupportsAccountProfiles,
} from "@/lib/agents/providerCredentials";
import type { AccountProfile, Provider } from "@/types";

export interface AccountProfilesStoreSlice {
	accounts: AccountProfile[];
	/** provider별 활성 계정 id (없으면 기본 계정) */
	activeAccounts: Partial<Record<Provider, string>>;

	addAccount: (a: Omit<AccountProfile, "id">) => AccountProfile;
	renameAccount: (id: string, name: string) => void;
	removeAccount: (id: string) => void;
	setActiveAccount: (provider: Provider, id?: string) => void;
}

type AccountProfilesHostState = AccountProfilesStoreSlice;

type SliceSet = (
	updater: (
		state: AccountProfilesHostState,
	) => AccountProfilesHostState | Partial<AccountProfilesHostState>,
) => void;

export function createAccountProfilesStoreSlice(
	set: SliceSet,
	_get: () => AccountProfilesHostState,
): AccountProfilesStoreSlice {
	return {
		accounts: [],
		activeAccounts: {},

		addAccount: (a) => {
			if (!providerSupportsAccountProfiles(a.provider)) {
				throw new ProviderCredentialUnsupportedError(a.provider);
			}
			const acc: AccountProfile = { ...a, id: `acc-${nanoid(8)}` };
			set((s) => ({ accounts: [...s.accounts, acc] }));
			return acc;
		},

		renameAccount: (id, name) =>
			set((s) => ({
				accounts: s.accounts.map((a) => (a.id === id ? { ...a, name } : a)),
			})),

		removeAccount: (id) =>
			set((s) => {
				const activeAccounts = { ...s.activeAccounts };
				for (const k of Object.keys(activeAccounts) as Provider[]) {
					if (activeAccounts[k] === id) delete activeAccounts[k];
				}
				return {
					accounts: s.accounts.filter((a) => a.id !== id),
					activeAccounts,
				};
			}),

		setActiveAccount: (provider, id) => {
			if (!providerSupportsAccountProfiles(provider)) {
				throw new ProviderCredentialUnsupportedError(provider);
			}
			set((s) => ({
				activeAccounts: {
					...s.activeAccounts,
					[provider]: id,
				},
			}));
		},

	};
}
