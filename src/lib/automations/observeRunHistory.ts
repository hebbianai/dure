interface RunHistoryObserver<Run, Inspection> {
	list: () => Promise<Run[]>;
	select: (runs: Run[]) => string | undefined;
	inspect: (id: string) => Promise<Inspection>;
	onList?: (runs: Run[]) => void;
	onResult: (runs: Run[], inspection: Inspection | undefined) => void;
	onError: (reason: unknown) => void;
	onLoading: (loading: boolean) => void;
}

/** Owns one view's read lifetime. Retirement suppresses follow-up reads and
 * publications; it does not cancel a backend operation or end a Run. */
export function observeRunHistory<Run, Inspection>(
	observer: RunHistoryObserver<Run, Inspection>,
): () => void {
	let current = true;
	let timer: ReturnType<typeof setTimeout> | undefined;
	async function read() {
		observer.onLoading(true);
		try {
			const runs = await observer.list();
			if (!current) return;
			observer.onList?.(runs);
			const id = observer.select(runs);
			const inspection = id ? await observer.inspect(id) : undefined;
			if (!current) return;
			observer.onResult(runs, inspection);
		} catch (reason) {
			if (current) observer.onError(reason);
		} finally {
			if (current) {
				observer.onLoading(false);
				timer = setTimeout(() => void read(), 5000);
			}
		}
	}
	void read();
	return () => {
		current = false;
		clearTimeout(timer);
	};
}
