import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { FLOATING_SURFACE } from "@/components/ui/alert";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
	restartPreparationSnapshot,
	subscribeRestartPreparation,
} from "@/lib/workspace/window/appRestart";

/** The band itself — a mode notice, not an alert: no close, gone when the
 * state ends. It wears the family's floating surface at the window's top
 * edge (owner call 2026-09-12), and is exported so the dev notice showcase
 * can draw it without preparing a restart.
 *
 * It clears the window's chrome bar rather than sitting 20px from the top:
 * the space tabs live in that bar, and at top-5 the band covered them
 * (owner screenshot 2026-09-13). 8px under the bar, so the band reads as
 * the first thing inside the window's body. */
export function RestartPreparationBand({ className }: { className?: string }) {
	return (
		<div
			role="status"
			aria-live="polite"
			className={cn(
				"fixed inset-x-5 top-[calc(var(--app-chrome-bar-height)+0.5rem)] z-[200] mx-auto max-w-lg px-3 py-2 text-xs text-foreground",
				FLOATING_SURFACE,
				className,
			)}
		>
			<p>{t("platform.updater.preparing")}</p>
			<p className="mt-0.5 text-muted-foreground">
				{t("platform.updater.cancelRestart")}
			</p>
		</div>
	);
}

/** Outside the temporarily inert workspace, so assistive technology can read it. */
export function RestartPreparationNotice() {
	const preparing = useSyncExternalStore(
		subscribeRestartPreparation,
		restartPreparationSnapshot,
	);
	return preparing
		? createPortal(<RestartPreparationBand />, document.body)
		: null;
}
