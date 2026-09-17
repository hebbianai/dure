export type UsageRefreshProvider = "codex" | "claude";

interface RecentUsageWindows<T, M = unknown> {
	fiveHours: T;
	twentyFourHours: T;
	telemetry: M;
}

interface RecentUsageClient<T, M> {
	get(hours: number): Promise<T>;
	refresh(provider: UsageRefreshProvider): Promise<RecentUsageWindows<T, M>>;
}

export function createRecentUsageClient<T, M = unknown>(
	load: (refresh?: UsageRefreshProvider) => Promise<RecentUsageWindows<T, M>>,
	options: { freshForMs?: number; now?: () => number } = {},
): RecentUsageClient<T, M> {
	const freshForMs = options.freshForMs ?? 110_000;
	const now = options.now ?? Date.now;
	let cached: RecentUsageWindows<T, M> | null = null;
	let completedAt = 0;
	let inFlight: Promise<RecentUsageWindows<T, M>> | null = null;
	let inFlightRefresh: UsageRefreshProvider | undefined;

	const snapshot = (
		refresh?: UsageRefreshProvider,
	): Promise<RecentUsageWindows<T, M>> => {
		if (inFlight) {
			if (refresh && refresh !== inFlightRefresh) {
				// A cache read (or another provider's refresh) cannot satisfy this action.
				return inFlight.catch(() => {}).then(() => snapshot(refresh));
			}
			return inFlight;
		}
		if (!refresh && cached && now() - completedAt < freshForMs)
			return Promise.resolve(cached);
		inFlightRefresh = refresh;
		inFlight = load(refresh)
			.then((next) => {
				cached = next;
				completedAt = now();
				return next;
			})
			.finally(() => {
				inFlight = null;
				inFlightRefresh = undefined;
			});
		return inFlight;
	};

	return {
		refresh: (provider) => snapshot(provider),
		get(hours) {
			return snapshot().then((value) =>
				hours <= 5 ? value.fiveHours : value.twentyFourHours,
			);
		},
	};
}
