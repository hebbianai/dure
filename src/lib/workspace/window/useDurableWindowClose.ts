import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef } from "react";
import { t } from "@/lib/i18n";
import { settleDurableAppState } from "@/lib/persistence/durableAppStateSettlement";
import { checkpointWindowWork } from "@/lib/persistence/windowWorkCheckpoint";
import { showErrorToast } from "@/lib/toast";
import { createDurableWindowCloseBarrier } from "@/lib/workspace/window/durableWindowClose";

export interface DurableWindowCloseOptions {
	readonly enabled?: boolean;
	readonly prepare?: () => Promise<void> | void;
	readonly close?: () => Promise<void>;
	readonly onFailure?: (error: unknown) => Promise<void> | void;
}

/** Installs the single close transaction for a state-owning WebView. */
export function useDurableWindowClose(
	options: DurableWindowCloseOptions = {},
): void {
	const runtimeRef = useRef(options);
	runtimeRef.current = options;

	useEffect(() => {
		if (options.enabled === false) return;
		const win = getCurrentWindow();
		const barrier = createDurableWindowCloseBarrier({
			prepare: () => runtimeRef.current.prepare?.(),
			settleDurableState: async () => {
				const resume = await checkpointWindowWork();
				try { await settleDurableAppState(); } finally { resume(); }
			},
			close: () => runtimeRef.current.close?.() ?? win.close(),
			onFailure: async (error) => {
				showErrorToast(t("persistence.windowClose.failedCloseAgain"));
				await runtimeRef.current.onFailure?.(error);
			},
		});
		const unlisten = win.onCloseRequested((event) => barrier.handle(event));
		return () => {
			void unlisten.then((dispose) => dispose());
		};
	}, [options.enabled]);
}
