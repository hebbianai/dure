import { t } from "@/lib/i18n";
import { isTauri } from "@/lib/ipc/core";
import { setAppQuitConfirmationCopy } from "@/lib/ipc/system";
import { isMacPlatform } from "@/lib/workspace/desktop/desktopPlatform";

/** Native Quit remains usable before boot and without WebViews. Windows only
 * project the current translations; the native app owns confirmation and exit. */
export async function syncNativeQuitConfirmationCopy(): Promise<void> {
	if (!isTauri() || !isMacPlatform()) return;
	await setAppQuitConfirmationCopy({
		"app.quit.title": t("app.quit.title"),
		"app.quit.message": t("app.quit.message"),
		"app.quit.confirm": t("app.quit.confirm"),
		"app.quit.cancel": t("app.quit.cancel"),
	});
}
