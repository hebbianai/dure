import { inspect } from "node:util";

// Node's fast exit path (process.exit(), an uncaught exception or an unhandled
// rejection) joins V8's worker threads before the isolate is torn down, and
// hangs forever when a concurrent compile is parked on a background GC request
// (hebbianai/dure#549). An entry point therefore returns with process.exitCode
// set, so normal isolate teardown releases those workers. This package is
// installed apart from the CLI, which keeps its own copy in cli/lib.

// A failure used to end the process at once, so a handle it abandoned must not
// now hold the process open. By then the idle loop has served any pending
// background collection request.
const ABANDONED_HANDLE_GRACE_MS = 1_000;

/** Runs a process entry point and leaves through normal isolate teardown. */
export async function runEntryPoint(entry) {
	try {
		await entry();
	} catch (error) {
		// Node's report of an uncaught exception, without the source excerpt.
		process.stderr.write(`${inspect(error)}\n`);
		// As for an uncaught exception, an exit code that is already set wins.
		process.exitCode ??= 1;
		setTimeout(() => process.exit(), ABANDONED_HANDLE_GRACE_MS).unref();
	}
}
