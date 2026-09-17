import { definePaneAction } from "@/lib/workspace/pane/paneAction";
import type { PaneQuickCommandTarget } from "@/lib/workspace/pane/paneQuickCommandTarget";

/** The mounted terminal's existing controller owns input fencing and receipts. */
export function terminalPaneInputAction(send: PaneQuickCommandTarget) {
	return definePaneAction(
		{
			description:
				"Paste text into this terminal; optionally press Enter after the paste is written to the PTY. Applied confirms input delivery, not command completion.",
			parameters: {
				text: { type: "string", required: true },
				appendEnter: { type: "boolean", description: "Defaults to false." },
			},
		},
		async ({ text, appendEnter }) => {
			const input = text as string;
			if (
				Array.from(input).some((character) => {
					const code = character.charCodeAt(0);
					return (
						(code < 32 && code !== 9 && code !== 10 && code !== 13) ||
						code === 127
					);
				})
			) {
				return {
					outcome: "refused",
					error: {
						code: "terminal_input_invalid",
						message: "Text must not contain terminal control characters.",
						retryable: false,
					},
				};
			}
			try {
				await send({
					id: "terminal.input",
					label: "Terminal input",
					text: input,
					appendEnter: appendEnter === true,
				});
				return { outcome: "applied" };
			} catch {
				return {
					outcome: "failed",
					error: {
						code: "terminal_input_unconfirmed",
						message:
							"Terminal input was not fully confirmed. Inspect the terminal before sending new input.",
						retryable: false,
					},
				};
			}
		},
	);
}
