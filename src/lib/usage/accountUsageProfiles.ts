import type { AccountUsageProfileInput } from "@/lib/ipc";
import type { AccountProfile } from "@/types";

/** Providers whose accounts the app's periodic account usage check reads. */
const CHECKED_PROVIDERS = ["codex", "claude"] as const;

/** The check's account catalog: each checked provider's default login and
 * its registered accounts. Credential contents are never sent. */
export function accountUsageProfiles(
	accounts: readonly AccountProfile[],
): AccountUsageProfileInput[] {
	return CHECKED_PROVIDERS.flatMap((providerId) => [
		{ providerId, credentialId: null, directory: null },
		...accounts
			.filter((account) => account.provider === providerId)
			.map((account) => ({
				providerId,
				credentialId: account.id,
				directory: account.dir,
			})),
	]);
}
