import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { t } from "@/lib/i18n";
import { showErrorToast, showToast } from "@/lib/toast";

export interface CopyTextToClipboardOptions {
	/** Success toast copy. Defaults to the shared "클립보드에 복사됨". */
	successMessage?: string;
	/** Failure toast copy. Defaults to the shared "클립보드에 복사하지 못했습니다". */
	errorMessage?: string;
	/** The pane the copy was made in, so the toast lands there. */
	paneId?: string;
}

/**
 * Write text to the OS clipboard and toast the outcome.
 *
 * One shared wrapper for the copy-then-toast pattern repeated across pane
 * menus and session lists (PaneChrome's copy-identifier action, the recent
 * session row's copy actions): a successful write shows a short
 * info toast, a failed write shows an error toast instead of failing
 * silently. Callers with bespoke copy pass their own messages; defaults are
 * resolved through t() at call time so a language switch is honored.
 *
 * @returns true when the clipboard write succeeded.
 */
export async function copyTextToClipboard(
	text: string,
	options?: CopyTextToClipboardOptions,
): Promise<boolean> {
	const paneId = options?.paneId;
	try {
		await writeText(text);
		const message = options?.successMessage ?? t("common.copiedToClipboard");
		if (paneId) showToast(message, { paneId });
		else showToast(message);
		return true;
	} catch {
		const message = options?.errorMessage ?? t("common.copyToClipboardFailed");
		if (paneId) showErrorToast(message, { paneId });
		else showErrorToast(message);
		return false;
	}
}
