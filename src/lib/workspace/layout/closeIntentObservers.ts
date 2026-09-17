/** Live resource subscribers only; the durable close journals own close state. */
const observers = new Map<string, Set<() => void | Promise<void>>>();

export function observeCloseIntent(
	desktopId: string,
	observe: () => void | Promise<void>,
): () => void {
	const desktop = observers.get(desktopId) ?? new Set();
	observers.set(desktopId, desktop);
	desktop.add(observe);
	return () => {
		desktop.delete(observe);
		if (desktop.size === 0) observers.delete(desktopId);
	};
}

/** Notify synchronously, then wait for every affected attachment to retire. */
export async function settleCloseIntentObservers(
	desktopId: string,
): Promise<void> {
	const results = [...(observers.get(desktopId) ?? [])].map((observe) => {
		try {
			return Promise.resolve(observe());
		} catch (error) {
			return Promise.reject(error);
		}
	});
	const settled = await Promise.allSettled(results);
	for (const result of settled)
		if (result.status === "rejected") throw result.reason;
}

export function notifyCloseIntentCleared(desktopId: string): void {
	void settleCloseIntentObservers(desktopId).catch((error) => {
		console.warn("[workspace] close intent observer failed", error);
	});
}
