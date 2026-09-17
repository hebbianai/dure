import {
	type FrameBudgetScheduler,
	getFrameBudgetScheduler,
} from "@/lib/scheduling/frameBudgetScheduler";
import type { TerminalPresentationRole } from "@/lib/terminal/presentation/terminalPresentationRoleStore";
import type { StructuredTerminalCarrierRecord } from "@/lib/terminal/structuredTerminalRecord";

/** One ordered reader per attachment, independent of its paint queue. At most
 * one decoded record waits for the shared apply budget; the Host retains the
 * remaining stream. Receipts and events never wait for background painting;
 * interactive panes keep their existing immediate delivery path.
 */
export async function runTerminalRecordDelivery({
	read,
	consume,
	isCurrent,
	readRole,
	signal,
	scheduler = getFrameBudgetScheduler(),
}: {
	read: () => Promise<StructuredTerminalCarrierRecord>;
	consume: (record: StructuredTerminalCarrierRecord) => boolean;
	isCurrent: () => boolean;
	readRole: () => TerminalPresentationRole;
	signal: AbortSignal;
	scheduler?: Pick<FrameBudgetScheduler, "schedule">;
}): Promise<void> {
	while (!signal.aborted && isCurrent()) {
		const record = await read();
		if (signal.aborted || !isCurrent()) return;
		if (
			readRole() !== "background" ||
			record.kind !== "terminal" ||
			record.decoded.record.body.case !== "viewportFrame"
		) {
			if (!consume(record)) return;
			continue;
		}
		const consumed = await new Promise<boolean>((resolve, reject) => {
			let cancel = () => {};
			const abort = () => {
				cancel();
				resolve(false);
			};
			signal.addEventListener("abort", abort, { once: true });
			cancel = scheduler.schedule(
				"reveal",
				() => {
					signal.removeEventListener("abort", abort);
					try {
						resolve(!signal.aborted && isCurrent() && consume(record));
					} catch (error) {
						reject(error);
					}
				},
				"structured-terminal-delivery",
				{ completion: "inline" },
			);
		});
		if (!consumed) return;
	}
}
