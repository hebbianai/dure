/**
 * The one sentence to show when a spawn saga did not succeed.
 *
 * The receipt records every step, and a failed run usually has exactly one
 * step that says why. Showing the receipt's `state` instead ("failed") tells
 * somebody nothing they can act on, so the step's own message wins and the
 * state is the fallback for a run that failed without one.
 *
 * The *latest* failed step, not the first: a compensating run can fail again
 * on the way back out, and the last thing that went wrong is the one still
 * standing in the person's way.
 */

import type { SpawnReceipt } from "@/lib/ipc/spawn";

export function spawnFailureMessage(receipt: SpawnReceipt): string {
	const failed = receipt.steps.reduce<
		SpawnReceipt["steps"][number] | undefined
	>(
		(latest, step) =>
			step.status === "failed" &&
			(!latest || (step.endedAt ?? -1) >= (latest.endedAt ?? -1))
				? step
				: latest,
		undefined,
	);
	return failed?.error?.message ?? receipt.state;
}
