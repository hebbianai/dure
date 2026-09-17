import type { PluginListener } from "@tauri-apps/api/core";

/** The last rendered layer supplies its existing back/cancel action. */
export function createNativeBack() {
	let action: (() => void) | undefined;
	let listener: PluginListener | undefined;
	let syncing = false;
	let disposed = false;
	let failed = false;
	const android = /Android/i.test(navigator.userAgent);

	async function sync(): Promise<void> {
		if (!android || syncing || failed) return;
		syncing = true;
		try {
			// Registration is asynchronous. Re-read the desired state after each
			// native operation so a late registration cannot outlive its screen.
			while (Boolean(listener) !== Boolean(action && !disposed)) {
				if (listener) {
					await listener.unregister();
					listener = undefined;
				} else {
					const { onBackButtonPress } = await import("@tauri-apps/api/app");
					listener = await onBackButtonPress(() => {
						if (!disposed) action?.();
					});
				}
			}
		} catch (error) {
			failed = true;
			console.warn("Android back navigation unavailable", error);
		} finally {
			syncing = false;
		}
	}

	return {
		begin() {
			action = undefined;
		},
		bind(callback: () => void, blocked = false): () => void {
			action = blocked ? () => {} : callback;
			return callback;
		},
		commit() {
			void sync();
		},
		dispose() {
			disposed = true;
			action = undefined;
			void sync();
		},
	};
}
