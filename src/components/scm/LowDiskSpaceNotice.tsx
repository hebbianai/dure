import { useSyncExternalStore } from "react";
import { useLocalRepositoryProjects } from "@/components/scm/useLocalRepositoryProjects";
import { FLOATING_CARD } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import {
	dismissLowDiskNotice,
	getWorktreeReclaimState,
	type LowDiskOffer,
	lowDiskOffer,
	subscribeWorktreeReclaim,
} from "@/lib/scm/worktrees/worktreeReclaimStore";
import { openSettingsPage } from "@/lib/settings/settingsBus";
import { formatBytes } from "@/lib/usage/systemResources";

export function useLowDiskOffer(): LowDiskOffer | null {
	return lowDiskOffer(
		useSyncExternalStore(subscribeWorktreeReclaim, getWorktreeReclaimState),
	);
}

/** Free space is low on a volume holding a project, and finished Run
 * worktrees there are safe to remove (#623). The card names what they free
 * and opens Settings → Storage, where the list and the one confirmed removal
 * live. Shown in the main window's notice corner; `hidden` yields it to a
 * modal or a notice that outranks it (Toaster decides). */
export function LowDiskSpaceNotice({ hidden = false }: { hidden?: boolean }) {
	const offer = useLowDiskOffer();
	const projects = useLocalRepositoryProjects();
	if (hidden || !offer) return null;
	const size = formatBytes(offer.bytes);
	const project =
		projects.find((candidate) => candidate.path === offer.projectPaths[0])
			?.name ?? offer.projectPaths[0];
	return (
		<div className="fixed right-5 bottom-5 z-[100] w-[min(24rem,calc(100vw-2.5rem))]">
			<section
				aria-labelledby="low-disk-space-title"
				className={`pointer-events-auto p-4 text-foreground ${FLOATING_CARD}`}
			>
				<h2 id="low-disk-space-title" className="text-base font-semibold">
					{t("settings.storage.lowDisk.title", {
						free: formatBytes(offer.freeBytes),
					})}
				</h2>
				<p className="mt-3 text-sm text-muted-foreground">
					{offer.count === 1
						? t("settings.storage.lowDisk.bodyOne", { project, size })
						: t("settings.storage.lowDisk.bodyMany", {
								count: offer.count,
								size,
							})}
				</p>
				<div className="mt-4 flex flex-wrap items-center gap-2">
					<Button
						type="button"
						size="sm"
						onClick={() => {
							dismissLowDiskNotice();
							openSettingsPage("storage");
						}}
					>
						{t("settings.storage.lowDisk.review")}
					</Button>
					<Button
						type="button"
						size="sm"
						variant="outline"
						onClick={dismissLowDiskNotice}
					>
						{t("settings.storage.lowDisk.notNow")}
					</Button>
				</div>
			</section>
		</div>
	);
}
