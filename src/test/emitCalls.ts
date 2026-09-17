import type { Mock } from "vitest";

/**
 * Selects the calls to a mocked `emit` that carry one named event.
 *
 * A suite that mocks `@tauri-apps/api/event` catches every emit the module
 * graph makes, not only the one under test: each durable store commit
 * publishes `dure://persistence/store-changed` through the same function. So
 * `toHaveBeenCalledTimes(1)` on the raw mock does not mean "the code emitted
 * its event once" — it means "nothing else in the process emitted anything",
 * which is a claim the suite never intended to make and cannot keep. Filter
 * by name and the assertion says what it means.
 */
export function emitCallsFor<Args extends unknown[]>(
	emit: Mock<(...args: Args) => unknown>,
	event: string,
): Args[] {
	return emit.mock.calls.filter((call) => call[0] === event);
}
