type QaFatalConsoleSignature =
	| "webgl_context_exhausted"
	| "webgl_context_lost"
	| "tauri_callback_missing"
	| "xterm_task_queue_deadline";

export interface QaFatalConsoleMatch {
	signature: QaFatalConsoleSignature;
	message: string;
	stack?: string;
}

const FATAL_CONSOLE_PATTERNS: ReadonlyArray<{
	signature: QaFatalConsoleSignature;
	matches(message: string): boolean;
}> = [
	{
		signature: "webgl_context_exhausted",
		matches: (message) => /too many active webgl contexts/i.test(message),
	},
	{
		signature: "webgl_context_lost",
		matches: (message) =>
			/webgl context not restored/i.test(message) ||
			(/\bwebgl\b/i.test(message) && /\bcontext\b.*\blost\b/i.test(message)),
	},
	{
		signature: "tauri_callback_missing",
		matches: (message) =>
			/\[tauri\].*couldn(?:['’])?t find callback id/i.test(message),
	},
	{
		signature: "xterm_task_queue_deadline",
		matches: (message) =>
			/task queue exceeded allotted deadline/i.test(message),
	},
];

function printableConsoleArgument(value: unknown): string {
	try {
		return String(value);
	} catch {
		return "<unprintable console argument>";
	}
}

/** Returns only console diagnostics that invalidate terminal runtime QA. */
export function classifyQaFatalConsoleMessage(
	args: readonly unknown[],
): QaFatalConsoleMatch | undefined {
	const message = args.map(printableConsoleArgument).join(" ");
	const pattern = FATAL_CONSOLE_PATTERNS.find((candidate) =>
		candidate.matches(message),
	);
	if (!pattern) return undefined;
	const error = args.find(
		(argument): argument is Error => argument instanceof Error,
	);
	return {
		signature: pattern.signature,
		message,
		...(error?.stack ? { stack: error.stack } : {}),
	};
}
