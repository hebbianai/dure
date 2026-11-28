import { createBroadcast } from "@/lib/state/broadcast";
import type { HmuxControlPlaneCensus } from "@/lib/ipc";

/** When the census a publication carries was requested. */
interface HmuxControlPlaneCensusReceipt {
	readonly requestedAtMs: number;
}

type CensusListener = (
	census: HmuxControlPlaneCensus,
	receipt: HmuxControlPlaneCensusReceipt,
) => void;

interface CensusPublication {
	readonly census: HmuxControlPlaneCensus;
	readonly receipt: HmuxControlPlaneCensusReceipt;
}

let latest: CensusPublication | undefined;
const censuses = createBroadcast<CensusPublication>();

/** Shares the complete main-window census with startup consumers. A partial
 * per-session metadata map is deliberately not enough to authorize absence. */
export function publishHmuxControlPlaneCensus(
	census: HmuxControlPlaneCensus,
	requestedAtMs: number = Date.now(),
): void {
	latest = { census, receipt: { requestedAtMs } };
	censuses.publish(latest);
}

export function subscribeHmuxControlPlaneCensus(
	listener: CensusListener,
): () => void {
	const unsubscribe = censuses.subscribe(({ census, receipt }) =>
		listener(census, receipt),
	);
	if (latest) listener(latest.census, latest.receipt);
	return unsubscribe;
}

/** Calls `listener` once, with the first complete census requested at or
 * after `sinceMs`: one that cannot predate what happened at that moment.
 * Returns a cancel. */
export function subscribeHmuxControlPlaneCensusSince(
	sinceMs: number,
	listener: (census: HmuxControlPlaneCensus) => void,
): () => void {
	let done = false;
	const unsubscribe = subscribeHmuxControlPlaneCensus((census, receipt) => {
		if (done || receipt.requestedAtMs < sinceMs) return;
		done = true;
		queueMicrotask(stop);
		listener(census);
	});
	function stop() {
		done = true;
		unsubscribe();
	}
	return stop;
}
