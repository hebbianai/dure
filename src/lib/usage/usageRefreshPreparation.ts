import { codexUsageProfilesSync } from "@/lib/ipc";
import type { AccountProfile } from "@/types";
import { codexUsageProfiles } from "./codexUsageSnapshots";
import type { UsageRefreshProvider } from "./recentUsageClient";

const refreshPreparations: Partial<
	Record<
		UsageRefreshProvider,
		(accounts: readonly AccountProfile[]) => Promise<unknown>
	>
> = {
	codex: (accounts) => codexUsageProfilesSync(codexUsageProfiles(accounts)),
};

/** Refresh collectors that require an account catalog before reading usage. */
export function prepareUsageRefresh(
	provider: UsageRefreshProvider,
	accounts: readonly AccountProfile[],
) {
	return refreshPreparations[provider]?.(accounts);
}
