import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	BellEventSchema,
	TerminalEventSchema,
} from "@/contracts/terminalStateProtocol";
import {
	createTerminalViewportEventCursor,
	observeTerminalViewportEventHighWater,
	reduceTerminalViewportEvent,
} from "./terminalViewportEventCursor";

const bell = (eventId: bigint) =>
	create(TerminalEventSchema, {
		eventId,
		event: { case: "bell", value: create(BellEventSchema) },
	});

describe("terminal viewport event cursor", () => {
	it("deduplicates initial effects and applies each live event exactly once", () => {
		const seeded = observeTerminalViewportEventHighWater(
			createTerminalViewportEventCursor(),
			"terminal-a",
			7n,
		);
		expect(
			reduceTerminalViewportEvent(seeded, "terminal-a", bell(7n)).status,
		).toBe("duplicate");
		const applied = reduceTerminalViewportEvent(seeded, "terminal-a", bell(8n));
		expect(applied.status).toBe("applied");
		if (applied.status !== "applied") throw new Error("event was not applied");
		expect(
			reduceTerminalViewportEvent(applied.cursor, "terminal-a", bell(8n))
				.status,
		).toBe("duplicate");
	});

	it("fails closed on event gaps, epoch changes, and frame watermark skips", () => {
		const seeded = observeTerminalViewportEventHighWater(
			createTerminalViewportEventCursor(),
			"terminal-a",
			3n,
		);
		expect(
			reduceTerminalViewportEvent(seeded, "terminal-a", bell(5n)).status,
		).toBe("reattach_required");
		expect(
			reduceTerminalViewportEvent(seeded, "terminal-b", bell(4n)).status,
		).toBe("reattach_required");
		expect(() =>
			observeTerminalViewportEventHighWater(seeded, "terminal-a", 2n),
		).toThrow("skipped an ordered event");
		expect(() =>
			observeTerminalViewportEventHighWater(seeded, "terminal-a", 4n),
		).toThrow("skipped an ordered event");
	});
});
