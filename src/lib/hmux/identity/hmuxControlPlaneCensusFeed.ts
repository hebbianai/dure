import { createBroadcast } from "@/lib/state/broadcast";
import type { HmuxControlPlaneCensus } from "@/lib/ipc";

type CensusListener = (census: HmuxControlPlaneCensus) => void;

let latest: HmuxControlPlaneCensus | undefined;
const censuses = createBroadcast<HmuxControlPlaneCensus>();

/** Shares the complete main-window census with startup consumers. A partial
 * per-session metadata map is deliberately not enough to authorize absence. */
export function publishHmuxControlPlaneCensus(
	census: HmuxControlPlaneCensus,
): void {
	latest = census;
	censuses.publish(census);
}

export function subscribeHmuxControlPlaneCensus(
	listener: CensusListener,
): () => void {
	const unsubscribe = censuses.subscribe(listener);
	if (latest) listener(latest);
	return unsubscribe;
}
