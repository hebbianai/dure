import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useCallback, useEffect, useRef, useState } from "react";

export type CopyFeedbackStatus = "idle" | "copied" | "failed";

export interface UseCopyFeedbackOptions {
	/** How long "copied"/"failed" stays before reverting to "idle". */
	resetMs?: number;
	/** Clipboard writer — inject a navigator.clipboard writer or a test double. */
	write?: (text: string) => Promise<void>;
}

/**
 * Headless inline copy feedback: write text to the clipboard, expose the
 * outcome as a short-lived status, then revert to "idle".
 *
 * Extracts the copy-then-revert pattern of PaneInfoDialog's field copy
 * (1.8s revert, copied/failed) and MobilePairingPage's pairing-code copy
 * (2s revert — pass `resetMs: 2000`). Rapid copies are last-write-wins:
 * the previous revert timer is cleared so the newest outcome keeps the full
 * window. A pending revert timer is cleared on unmount.
 */
export function useCopyFeedback(options?: UseCopyFeedbackOptions): {
	status: CopyFeedbackStatus;
	copy: (text: string) => Promise<Exclude<CopyFeedbackStatus, "idle">>;
} {
	const resetMs = options?.resetMs ?? 1_800;
	const write = options?.write ?? writeText;
	const [status, setStatus] = useState<CopyFeedbackStatus>("idle");
	const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
		undefined,
	);

	useEffect(
		() => () => {
			if (resetTimer.current !== undefined) clearTimeout(resetTimer.current);
		},
		[],
	);

	const copy = useCallback(
		async (text: string) => {
			let outcome: Exclude<CopyFeedbackStatus, "idle">;
			try {
				await write(text);
				outcome = "copied";
			} catch {
				outcome = "failed";
			}
			if (resetTimer.current !== undefined) clearTimeout(resetTimer.current);
			setStatus(outcome);
			resetTimer.current = setTimeout(() => {
				setStatus("idle");
				resetTimer.current = undefined;
			}, resetMs);
			return outcome;
		},
		[resetMs, write],
	);

	return { status, copy };
}
