import { classifyQaFatalConsoleMessage } from "@/lib/qa/qaFatalConsoleClassifier";
import type { QaRuntimeErrorInput } from "@/lib/qa/qaRuntimeErrorLedger";

type QaLogger = (...args: unknown[]) => void;
type QaConsole = {
	error: (...args: unknown[]) => void;
	warn?: (...args: unknown[]) => void;
};
type QaRuntimeErrorSink = (error: QaRuntimeErrorInput) => void;

/**
 * Mirror diagnostics into the dev log. Browser runtime failures and a narrow
 * set of fatal terminal console signatures reach the structured QA sink.
 */
export function installQaErrorCapture(
	target: Pick<EventTarget, "addEventListener">,
	consoleTarget: QaConsole,
	log: QaLogger,
	recordRuntimeError?: QaRuntimeErrorSink,
): void {
	target.addEventListener("error", (event) => {
		const error = event as ErrorEvent;
		log(
			"window.onerror",
			error.message,
			`${error.filename}:${error.lineno}:${error.colno}`,
		);
		recordRuntimeError?.({
			kind: "window_error",
			message: error.message,
			filename: error.filename,
			line: error.lineno,
			column: error.colno,
			stack: error.error instanceof Error ? error.error.stack : undefined,
		});
	});
	target.addEventListener("unhandledrejection", (event) => {
		const rejection = event as PromiseRejectionEvent;
		log(
			"unhandledrejection",
			String(rejection.reason),
			(rejection.reason as Error)?.stack ?? "",
		);
		recordRuntimeError?.({
			kind: "unhandled_rejection",
			message: String(rejection.reason),
			stack:
				rejection.reason instanceof Error ? rejection.reason.stack : undefined,
		});
	});
	const originalError = consoleTarget.error.bind(consoleTarget);
	consoleTarget.error = (...args: unknown[]) => {
		log("console.error", ...args.map(String));
		recordFatalConsoleMessage(args, recordRuntimeError);
		originalError(...args);
	};
	if (consoleTarget.warn) {
		const originalWarn = consoleTarget.warn.bind(consoleTarget);
		consoleTarget.warn = (...args: unknown[]) => {
			log("console.warn", ...args.map(String));
			recordFatalConsoleMessage(args, recordRuntimeError);
			originalWarn(...args);
		};
	}
}

function recordFatalConsoleMessage(
	args: readonly unknown[],
	recordRuntimeError?: QaRuntimeErrorSink,
): void {
	const fatal = classifyQaFatalConsoleMessage(args);
	if (!fatal) return;
	recordRuntimeError?.({
		kind: "fatal_console",
		message: `[${fatal.signature}] ${fatal.message}`,
		stack: fatal.stack,
	});
}
