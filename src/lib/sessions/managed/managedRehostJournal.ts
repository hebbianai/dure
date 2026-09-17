export interface ManagedRehostJournalOperation<T> {
	reconcile: () => Promise<T | null>;
	initiate: () => Promise<T>;
	isCompleted: (value: T) => boolean;
}

/** Reconcile before first admission and after every ambiguous outcome. */
export async function runManagedRehostJournalOperation<T>({
	reconcile,
	initiate,
	isCompleted,
}: ManagedRehostJournalOperation<T>): Promise<T> {
	const existing = await reconcile();
	if (existing) return existing;

	let initiated: T;
	try {
		initiated = await initiate();
	} catch (error) {
		const completed = await reconcile().catch(() => null);
		if (completed) return completed;
		throw error;
	}
	if (isCompleted(initiated)) return initiated;
	return (await reconcile().catch(() => null)) ?? initiated;
}
