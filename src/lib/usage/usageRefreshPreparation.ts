import { accountUsageProfilesSync } from "@/lib/ipc";
import type { AccountProfile } from "@/types";
import { accountUsageProfiles } from "./accountUsageProfiles";
import type { UsageRefreshProvider } from "./recentUsageClient";

/** Both providers' refreshes run the app's account usage check, which reads
 * the accounts its catalog lists. */
const syncCheckCatalog = (accounts: readonly AccountProfile[]) =>
	accountUsageProfilesSync(accountUsageProfiles(accounts));

const refreshPreparations: Partial<
	Record<
		UsageRefreshProvider,
		(accounts: readonly AccountProfile[]) => Promise<unknown>
	>
> = {
	codex: syncCheckCatalog,
	claude: syncCheckCatalog,
};

/** Refresh collectors that require an account catalog before reading usage. */
export function prepareUsageRefresh(
	provider: UsageRefreshProvider,
	accounts: readonly AccountProfile[],
) {
	return refreshPreparations[provider]?.(accounts);
}
