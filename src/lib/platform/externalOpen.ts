import { openUrl } from "@tauri-apps/plugin-opener";
import { t } from "@/lib/i18n";
import { showErrorToast } from "@/lib/toast";

/**
 * True when an opener failure only records that the user declined the open.
 *
 * The opener invoke serializes the Rust-side error into a string, so shape
 * checks are textual. Shapes the terminal link path (LegacyTerminalView and
 * the structured viewport falling back to openUrl) can see:
 *
 * - "Not allowed to open url {url}" / "Not allowed to open path {path}" —
 *   the plugin's scope denial. It embeds the raw URL, so it is classified
 *   first and never treated as a user choice (a URL may contain "cancel").
 * - Launcher/portal failures that spell out a cancellation, e.g. "The
 *   operation was canceled by the user." or an xdg portal "cancelled"
 *   response on Linux.
 * - macOS OSStatus userCanceledErr, reported as "-128".
 */
export function isUserCancelledExternalOpen(error: unknown): boolean {
	const text = error instanceof Error ? error.message : String(error);
	if (/^Not allowed to open (url|path)/.test(text)) return false;
	return /cancel/i.test(text) || /-128\b/.test(text);
}

/**
 * Open a URL with the system default handler and toast on failure.
 *
 * Replaces the silent `openUrl(url).catch(() => {})` pattern (AccountsPage's
 * account link, terminal link fallbacks): a real failure now tells the user
 * why nothing opened, while a user-cancelled open stays quiet — the user
 * already made that choice.
 */
export async function openExternalUrl(url: string): Promise<void> {
	try {
		await openUrl(url);
	} catch (error) {
		if (isUserCancelledExternalOpen(error)) return;
		showErrorToast(
			t("platform.externalOpen.failed", { error: String(error) }),
		);
	}
}
