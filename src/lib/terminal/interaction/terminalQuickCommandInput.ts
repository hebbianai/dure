import type { InputReceipt } from "@/contracts/terminalStateProtocol";
import {
	type QuickCommand,
	QuickCommandInputError,
} from "@/lib/workspace/pane/quickCommands";

/** Compose paste and optional Enter through the existing receipt stream. No
 * retries: a refused paste must never submit the pane's pre-existing draft. */
export function createTerminalQuickCommandInput(options: {
	isCurrent: () => boolean;
	canPasteMultiline: () => boolean;
	paste: (text: string) => bigint | undefined;
	enter: () => bigint | undefined;
}) {
	let disposed = false;
	let pending:
		| {
				recordId: bigint;
				appendEnter: boolean;
				resolve: () => void;
				reject: (error: Error) => void;
		  }
		| undefined;
	const fail = (
		key: ConstructorParameters<typeof QuickCommandInputError>[0],
	) => {
		const operation = pending;
		pending = undefined;
		operation?.reject(new QuickCommandInputError(key));
	};
	return {
		run(command: QuickCommand): Promise<void> {
			if (disposed || !options.isCurrent())
				return Promise.reject(
					new QuickCommandInputError("workspace.quickCommands.unavailable"),
				);
			if (pending)
				return Promise.reject(
					new QuickCommandInputError("workspace.quickCommands.busy"),
				);
			if (/[\r\n]/.test(command.text) && !options.canPasteMultiline()) {
				return Promise.reject(
					new QuickCommandInputError(
						"workspace.quickCommands.multilineUnavailable",
					),
				);
			}
			return new Promise((resolve, reject) => {
				const recordId = options.paste(command.text);
				if (recordId === undefined) {
					reject(
						new QuickCommandInputError("workspace.quickCommands.unavailable"),
					);
					return;
				}
				pending = {
					recordId,
					appendEnter: command.appendEnter,
					resolve,
					reject,
				};
			});
		},
		onReceipt(receipt: InputReceipt) {
			if (!pending || pending.recordId !== receipt.inReplyToRecordId) return;
			if (!options.isCurrent() || receipt.outcome.case !== "writtenToPty") {
				fail("workspace.quickCommands.unavailable");
				return;
			}
			if (pending.appendEnter) {
				pending.appendEnter = false;
				const recordId = options.enter();
				if (recordId === undefined) fail("workspace.quickCommands.enterFailed");
				else pending.recordId = recordId;
			} else {
				const operation = pending;
				pending = undefined;
				operation.resolve();
			}
		},
		dispose() {
			disposed = true;
			fail("workspace.quickCommands.unavailable");
		},
	};
}
