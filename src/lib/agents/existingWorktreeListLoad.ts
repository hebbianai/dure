import { t } from "@/lib/i18n";
import { type ExistingWorktreeList, listExistingWorktrees } from "@/lib/ipc";

const EXISTING_WORKTREE_LIST_TIMEOUT_MS = 8_000;

/** A Tauri invoke can remain pending when its backend task is orphaned during
 * a dev-app restart. Bound the presentation wait so the dialog always offers
 * an explicit retry; the backend remains the authority for every returned ref. */
export async function loadExistingWorktreeList(
	repo: string,
	preferredPath?: string,
): Promise<ExistingWorktreeList> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			listExistingWorktrees(repo, preferredPath),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => {
					reject(
						new Error(
							t("agents.worktree.listTimeout"),
						),
					);
				}, EXISTING_WORKTREE_LIST_TIMEOUT_MS);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
