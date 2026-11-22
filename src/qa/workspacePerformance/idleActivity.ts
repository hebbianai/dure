/** What the frontend asks of the backend and of its store while the QA
 * workload is idle. A native idle-CPU number says how much; these counters
 * say which commands and how much store churn produced it. QA-only: the
 * counters wrap the Tauri invoke entry point for the observation window and
 * restore it on dispose. */
export interface IdleActivityCounters {
	invokesByCommand: Record<string, number>;
	storeNotifications: number;
}

interface InvokeHost {
	invoke: (command: string, ...rest: unknown[]) => unknown;
}

/** The entry point `@tauri-apps/api/core` invoke resolves at call time. */
export function currentTauriInvokeHost(): InvokeHost | undefined {
	return (window as { __TAURI_INTERNALS__?: InvokeHost }).__TAURI_INTERNALS__;
}

export function installIdleActivityCounters(
	host: InvokeHost | undefined,
	subscribeStore: (listener: () => void) => () => void,
): { read(): IdleActivityCounters; dispose(): void } {
	const invokesByCommand: Record<string, number> = {};
	let storeNotifications = 0;
	const original = host?.invoke;
	if (host && original) {
		host.invoke = (command, ...rest) => {
			invokesByCommand[command] = (invokesByCommand[command] ?? 0) + 1;
			return original.call(host, command, ...rest);
		};
	}
	const unsubscribe = subscribeStore(() => {
		storeNotifications += 1;
	});
	return {
		read: () => ({
			invokesByCommand: { ...invokesByCommand },
			storeNotifications,
		}),
		dispose: () => {
			unsubscribe();
			if (host && original) host.invoke = original;
		},
	};
}
