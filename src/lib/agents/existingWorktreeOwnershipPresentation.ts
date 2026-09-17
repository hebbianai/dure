import { t } from "@/lib/i18n";
import type { ExistingWorktreeOwnership } from "@/lib/ipc";

export function existingWorktreeOwnershipGuidance(
	ownership: ExistingWorktreeOwnership,
): string {
	const owners = ownership.owners ?? [];
	const owner = owners[0];
	if (ownership.state === "live_owned" && owner) {
		return t("agents.worktree.inUseBy", { provider: owner.provider });
	}
	if (ownership.state === "live_owned" && ownership.claimReceiptId) {
		return t("agents.worktree.receiptStillActive", {
			receipt: ownership.claimReceiptId,
		});
	}
	if (ownership.state === "reserved" && ownership.claimReceiptId) {
		return t("agents.worktree.resumeSpawnReceipt", {
			receipt: ownership.claimReceiptId,
		});
	}
	return t("agents.worktree.ownershipNeedsReview");
}
