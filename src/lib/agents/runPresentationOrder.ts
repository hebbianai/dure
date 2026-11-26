import {
	type AgentRunParentRefV1,
	agentRunParentKey,
} from "@/lib/agents/agentRunParent";

/** What orders one Run's presentation among its lead's other workers: the
 * lead's Session or Agent and when the Run's spawn operation started. */
interface RunPresentationOrderKey {
	readonly operationId?: string;
	readonly parent?: AgentRunParentRefV1;
	readonly startedAtMs?: number;
}

/** One Run's place among the presentations this client is running for the
 * same lead. */
export interface RunPresentationTurn {
	/** Resolves once every earlier-started worker of the same lead that this
	 * client is presenting has committed its pane or failed. The wait is
	 * bounded: a stalled presentation delays its later siblings, never blocks
	 * them. */
	wait(): Promise<void>;
	/** Leave the queue, after the pane commit or on failure. Idempotent. */
	leave(): void;
}

/** Longer than a presentation normally takes to reach its pane commit, well
 * inside the 45 s the app gives a claimed presentation request. */
const RUN_PRESENTATION_ORDER_WAIT_MS = 10_000;

interface PendingPresentation {
	readonly startedAtMs: number;
	readonly operationId: string;
	readonly left: Promise<void>;
}

const UNORDERED: RunPresentationTurn = {
	wait: async () => {},
	leave: () => {},
};

function startsBefore(
	left: PendingPresentation,
	right: PendingPresentation,
): boolean {
	return left.startedAtMs !== right.startedAtMs
		? left.startedAtMs < right.startedAtMs
		: left.operationId < right.operationId;
}

/** Resolves when `settled` does or after `ms`, clearing its timer. */
async function within(settled: Promise<unknown>, ms: number): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			settled,
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** Commits one lead's concurrent Run presentations in start order rather than
 * in whatever order their asynchronous preparation finishes. A Run without a
 * parent or start time is not ordered. Presentations that do not overlap keep
 * arrival order: a committed pane never moves. */
export function createRunPresentationOrder(
	waitMs: number = RUN_PRESENTATION_ORDER_WAIT_MS,
) {
	const pendingByLead = new Map<string, Set<PendingPresentation>>();
	return function enter(key: RunPresentationOrderKey): RunPresentationTurn {
		const { parent, startedAtMs, operationId } = key;
		if (!parent || startedAtMs === undefined || operationId === undefined) {
			return UNORDERED;
		}
		const leadKey = agentRunParentKey(parent);
		const pending = pendingByLead.get(leadKey) ?? new Set();
		pendingByLead.set(leadKey, pending);
		let markLeft!: () => void;
		const self: PendingPresentation = {
			startedAtMs,
			operationId,
			left: new Promise<void>((resolve) => {
				markLeft = resolve;
			}),
		};
		pending.add(self);
		return {
			async wait() {
				const deadline = Date.now() + waitMs;
				for (;;) {
					const earlier = [...pending].filter((other) =>
						startsBefore(other, self),
					);
					const remaining = deadline - Date.now();
					if (earlier.length === 0 || remaining <= 0) return;
					await within(
						Promise.all(earlier.map((other) => other.left)),
						remaining,
					);
				}
			},
			leave() {
				if (!pending.delete(self)) return;
				if (pending.size === 0) pendingByLead.delete(leadKey);
				markLeft();
			},
		};
	};
}

/** This client's queue: each window presents only its own Spaces' panes. */
export const enterRunPresentationOrder = createRunPresentationOrder();

/** A presentation request's optional `startedAtMs`: absent stays absent, and
 * anything present must be a non-negative integer millisecond time. */
export function parseRequestedRunStartedAtMs(
	value: unknown,
	refuse: (message: string) => never,
): number | undefined {
	if (value === undefined) return undefined;
	return Number.isSafeInteger(value) && (value as number) >= 0
		? (value as number)
		: refuse("startedAtMs is invalid");
}
