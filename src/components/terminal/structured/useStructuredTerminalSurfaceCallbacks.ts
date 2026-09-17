import { useCallback } from "react";
import type { TerminalWindowFocusProbe } from "@/lib/terminal/terminalWindowFocusProbe";

/** Connect surface lifetime observations without making the view own retirement. */
export function useStructuredTerminalSurfaceCallbacks(
	probe: TerminalWindowFocusProbe | undefined,
	onRetirement: ((retirement: Promise<void>) => void) | undefined,
) {
	const onAttachmentStarted = useCallback(
		(attachmentId: string) => {
			probe?.onSurfaceAttachmentStarted?.(attachmentId);
		},
		[probe],
	);
	const onSurfaceRetirement = useCallback(
		(attachmentId: string, retirement: Promise<void>) => {
			onRetirement?.(retirement);
			probe?.onSurfaceRetirement?.(attachmentId, retirement);
		},
		[probe, onRetirement],
	);
	return {
		onAttachmentStarted: probe?.onSurfaceAttachmentStarted
			? onAttachmentStarted
			: undefined,
		onSurfaceRetirement:
			onRetirement || probe?.onSurfaceRetirement
				? onSurfaceRetirement
				: undefined,
	};
}
