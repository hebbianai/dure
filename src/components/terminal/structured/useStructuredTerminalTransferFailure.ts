import { useCallback } from "react";
import { describeExternalFileDropError } from "@/lib/files/externalFileDrop";
import { t } from "@/lib/i18n";
import { showErrorToast } from "@/lib/toast";

/**
 * A paste or drop that could not prepare its files leaves the attachment
 * healthy, so it is reported in this pane rather than as a terminal failure.
 */
export function useStructuredTerminalTransferFailure(
	paneId: string | undefined,
): (cause: unknown) => void {
	return useCallback(
		(cause: unknown) => {
			const message = describeExternalFileDropError(cause, t);
			if (paneId) showErrorToast(message, { paneId });
			else showErrorToast(message);
		},
		[paneId],
	);
}
