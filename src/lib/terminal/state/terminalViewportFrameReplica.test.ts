import { describe, expect, it } from "vitest";
import {
	createTerminalViewportFrameReplica,
	issueTerminalViewportIntent,
	reduceTerminalViewportFrame,
	type TerminalViewportFrameCandidate,
} from "./terminalViewportFrameReplica";

function frame(
	attachmentId: string,
	projectionRevision: bigint,
	options: Partial<TerminalViewportFrameCandidate<string>> = {},
): TerminalViewportFrameCandidate<string> {
	return {
		attachmentId,
		terminalEpoch: "terminal-a",
		stateRevision: projectionRevision,
		throughOutputSeq: projectionRevision,
		projectionRevision,
		damageBaseProjectionRevision: 0n,
		appliedIntentSeq: 0n,
		frame: `frame-${projectionRevision}`,
		...options,
	};
}

describe("terminal viewport frame replica", () => {
	it("replaces complete frames across projection revision gaps", () => {
		let replica = createTerminalViewportFrameReplica<string>("attach-a");
		const first = reduceTerminalViewportFrame(replica, frame("attach-a", 1n));
		expect(first.status).toBe("applied");
		replica = first.replica;

		const skipped = reduceTerminalViewportFrame(
			replica,
			frame("attach-a", 4n, { damageBaseProjectionRevision: 3n }),
		);

		expect(skipped).toMatchObject({
			status: "applied",
			paint: "full",
			replica: { projectionRevision: 4n, frame: "frame-4" },
		});
	});

	it("drops a retired attachment callback after a fresh attach", () => {
		const current = reduceTerminalViewportFrame(
			createTerminalViewportFrameReplica<string>("attach-b"),
			frame("attach-b", 1n),
		).replica;

		const stale = reduceTerminalViewportFrame(
			current,
			frame("attach-a", 99n, { frame: "stale" }),
		);

		expect(stale).toMatchObject({
			status: "stale_attachment",
			replica: { attachmentId: "attach-b", frame: "frame-1" },
		});
	});

	it("acknowledges ordered no-op intents without requiring changed rows", () => {
		let replica = reduceTerminalViewportFrame(
			createTerminalViewportFrameReplica<string>("attach-a"),
			frame("attach-a", 1n),
		).replica;
		const firstIntent = issueTerminalViewportIntent(replica);
		replica = firstIntent.replica;
		const secondIntent = issueTerminalViewportIntent(replica);
		replica = secondIntent.replica;

		expect(firstIntent.fence.intentSeq).toBe(1n);
		expect(secondIntent.fence.intentSeq).toBe(2n);
		const acknowledged = reduceTerminalViewportFrame(
			replica,
			frame("attach-a", 2n, {
				appliedIntentSeq: 2n,
				damageBaseProjectionRevision: 1n,
				frame: "same-rows-with-ack",
			}),
		);
		expect(acknowledged).toMatchObject({
			status: "applied",
			paint: "damage",
			replica: { appliedIntentSeq: 2n, frame: "same-rows-with-ack" },
		});
	});

	it("requires a fresh attach when canonical fences regress", () => {
		const replica = reduceTerminalViewportFrame(
			createTerminalViewportFrameReplica<string>("attach-a"),
			frame("attach-a", 5n),
		).replica;

		const regressed = reduceTerminalViewportFrame(
			replica,
			frame("attach-a", 6n, {
				stateRevision: 4n,
				throughOutputSeq: 4n,
			}),
		);

		expect(regressed).toMatchObject({
			status: "reattach_required",
			replica: { projectionRevision: 5n, frame: "frame-5" },
		});
	});
});
