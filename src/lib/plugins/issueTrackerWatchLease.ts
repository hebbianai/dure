import type { DureIssueTrackerWatchUnsubscribeRequest } from "@/lib/ipc/plugins";

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const FNV_MASK = 0xffffffffffffffffn;
const RELEASE_RETRY_DELAYS_MS = [50, 250, 1_000] as const;
const MAX_SUBSCRIBER_EPOCH = Number.MAX_SAFE_INTEGER;
const subscriberEpochState = globalThis as typeof globalThis & {
	__dureIssueTrackerSubscriberEpoch?: number;
};

function fnv1a64(value: string): string {
	let hash = FNV_OFFSET;
	for (let index = 0; index < value.length; index += 1) {
		const codeUnit = value.charCodeAt(index);
		hash ^= BigInt(codeUnit & 0xff);
		hash = (hash * FNV_PRIME) & FNV_MASK;
		hash ^= BigInt(codeUnit >>> 8);
		hash = (hash * FNV_PRIME) & FNV_MASK;
	}
	return hash.toString(16).padStart(16, "0");
}

export function issueTrackerWatchSubscriberId(
	namespace: string,
	identity: readonly unknown[],
): string {
	return `${namespace}:${fnv1a64(JSON.stringify(identity))}`;
}

export function nextIssueTrackerSubscriberEpoch(): number {
	const wallClockFloor = Date.now() * 1_000;
	const previous = subscriberEpochState.__dureIssueTrackerSubscriberEpoch ?? 0;
	const next = Math.max(wallClockFloor, previous + 1);
	if (!Number.isSafeInteger(next) || next <= 0 || next > MAX_SUBSCRIBER_EPOCH) {
		throw new Error("issue tracker subscriber epoch exhausted");
	}
	subscriberEpochState.__dureIssueTrackerSubscriberEpoch = next;
	return next;
}

type Unsubscribe = (
	request: DureIssueTrackerWatchUnsubscribeRequest,
) => Promise<boolean>;

const wait = (delayMs: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, delayMs));

export async function releaseIssueTrackerWatchLease(
	unsubscribe: Unsubscribe,
	request: DureIssueTrackerWatchUnsubscribeRequest,
	waitForRetry: (delayMs: number) => Promise<void> = wait,
): Promise<boolean> {
	for (let attempt = 0; ; attempt += 1) {
		try {
			if (await unsubscribe(request)) return true;
		} catch {
			// A rejected transport and a false backend receipt both leave the
			// exact logical lease unresolved, so they share one bounded retry.
		}
		const delay = RELEASE_RETRY_DELAYS_MS[attempt];
		if (delay === undefined) return false;
		await waitForRetry(delay);
	}
}
