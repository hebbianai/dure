import { inspect } from "node:util";

// The bundled Node can hang forever in its fast exit path. process.exit(), an
// uncaught exception and an unhandled rejection all end in Environment::Exit,
// which joins V8's worker threads before the isolate is torn down. A
// concurrent compile parked on a background GC request then waits for a
// main-thread collection that never runs (#549). Returning from the entry
// point with process.exitCode set lets the event loop drain instead, and
// normal isolate teardown releases those workers.

/** How long a failed entry point may leave the event loop running. A failure
 * used to end the process at once, so a child, socket or timer that it
 * abandoned must not now hold the process open. By then the idle loop has
 * served any pending background collection request. */
const ABANDONED_HANDLE_GRACE_MS = 1_000;

/** Ends a command with an exit status after it has written its own message. */
export class CommandExit extends Error {
  constructor(exitCode) {
    super(`command exited with status ${exitCode}`);
    this.name = "CommandExit";
    this.exitCode = exitCode;
  }
}

/** Runs a process entry point and leaves through normal isolate teardown
 * instead of process.exit() or an uncaught failure. */
export async function runEntryPoint(entry) {
  try {
    await entry();
  } catch (error) {
    if (error instanceof CommandExit) {
      process.exitCode = error.exitCode;
    } else {
      // Node's report of an uncaught exception, without the source excerpt.
      process.stderr.write(`${inspect(error)}\n`);
      // As for an uncaught exception, an exit code that is already set wins.
      process.exitCode ??= 1;
    }
    setTimeout(() => process.exit(), ABANDONED_HANDLE_GRACE_MS).unref();
  }
}
