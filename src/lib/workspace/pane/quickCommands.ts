/** Saved text is IDE presentation state, not a runtime launch definition. */
export interface QuickCommand {
	id: string;
	label: string;
	text: string;
	appendEnter: boolean;
}

export class QuickCommandInputError extends Error {
	constructor(
		message:
			| "workspace.quickCommands.unavailable"
			| "workspace.quickCommands.busy"
			| "workspace.quickCommands.multilineUnavailable"
			| "workspace.quickCommands.enterFailed",
	) {
		super(message);
		this.name = "QuickCommandInputError";
	}
}

export const QUICK_COMMAND_LABEL_LIMIT = 80;
export const QUICK_COMMAND_TEXT_LIMIT = 16_000;

/** Move an existing preset in the current preference order without rewriting it. */
export function moveQuickCommand(
	commands: QuickCommand[],
	id: string,
	direction: -1 | 1,
): QuickCommand[] {
	const from = commands.findIndex((command) => command.id === id);
	const to = from + direction;
	if (from < 0 || to < 0 || to >= commands.length) return commands;
	const next = [...commands];
	[next[from], next[to]] = [next[to], next[from]];
	return next;
}

/** Insert into an IDE-owned draft using the textarea's UTF-16 selection offsets. */
export function insertQuickCommandText(
	draft: string,
	text: string,
	selectionStart: number,
	selectionEnd: number,
) {
	// Match the browser textarea's newline normalization without changing the preset.
	const inserted = text.replace(/\r\n?/g, "\n");
	return {
		text: draft.slice(0, selectionStart) + inserted + draft.slice(selectionEnd),
		caret: selectionStart + inserted.length,
	};
}

export function isQuickCommandComplete(
	command: Pick<QuickCommand, "label" | "text">,
): boolean {
	return (
		command.label.trim().length > 0 &&
		command.label.length <= QUICK_COMMAND_LABEL_LIMIT &&
		command.text.trim().length > 0 &&
		command.text.length <= QUICK_COMMAND_TEXT_LIMIT &&
		!Array.from(command.text).some((character) => {
			const code = character.charCodeAt(0);
			return (
				(code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127
			);
		})
	);
}

/** Parse persisted or externally supplied preferences once; never truncate executable text. */
export function normalizeQuickCommands(value: unknown): QuickCommand[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	return value.flatMap((entry) => {
		if (
			!entry ||
			typeof entry !== "object" ||
			typeof entry.id !== "string" ||
			!entry.id ||
			seen.has(entry.id) ||
			typeof entry.label !== "string" ||
			typeof entry.text !== "string" ||
			typeof entry.appendEnter !== "boolean" ||
			!isQuickCommandComplete(entry)
		)
			return [];
		seen.add(entry.id);
		return [
			{
				id: entry.id,
				label: entry.label.trim(),
				text: entry.text,
				appendEnter: entry.appendEnter,
			},
		];
	});
}
