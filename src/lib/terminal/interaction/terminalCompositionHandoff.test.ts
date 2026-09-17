import { describe, expect, it } from "vitest";
import {
	retirePaintedTerminalCompositionHandoffs,
	terminalActiveCompositionText,
	terminalCompositionHandoffCanRetire,
	terminalCompositionProjectionText,
} from "./terminalCompositionHandoff";

describe("terminal composition handoff", () => {
	it("projects only the browser-owned Korean, Japanese, and generic preedit", () => {
		expect(terminalActiveCompositionText("금", "금")).toBe("금");
		expect(terminalActiveCompositionText("日本語", "にほんご")).toBe("日本語");
		expect(terminalActiveCompositionText("A🙂界", "A🙂界")).toBe("A🙂界");
		expect(terminalActiveCompositionText("", "你")).toBe("你");
	});

	it("projects pending Korean commits before the active preedit", () => {
		expect(
			terminalCompositionProjectionText([{ text: "지" }, { text: "금" }], "나"),
		).toBe("지금나");
	});

	it("requires the exact attachment acknowledgement and a newer painted projection", () => {
		const handoff = {
			attachmentToken: "attachment-a",
			baselineProjectionRevision: 7n,
			baselineThroughOutputSeq: 11n,
			writtenToPty: true,
		};
		expect(terminalCompositionHandoffCanRetire(handoff, null)).toBe(false);
		expect(
			terminalCompositionHandoffCanRetire(
				{ ...handoff, writtenToPty: false },
				{
					attachmentToken: "attachment-a",
					projectionRevision: 8n,
					throughOutputSeq: 12n,
				},
			),
		).toBe(false);
		expect(
			terminalCompositionHandoffCanRetire(handoff, {
				attachmentToken: "attachment-b",
				projectionRevision: 8n,
				throughOutputSeq: 12n,
			}),
		).toBe(false);
		expect(
			terminalCompositionHandoffCanRetire(handoff, {
				attachmentToken: "attachment-a",
				projectionRevision: 7n,
				throughOutputSeq: 12n,
			}),
		).toBe(false);
		expect(
			terminalCompositionHandoffCanRetire(handoff, {
				attachmentToken: "attachment-a",
				projectionRevision: 8n,
				throughOutputSeq: 11n,
			}),
		).toBe(false);
		expect(
			terminalCompositionHandoffCanRetire(handoff, {
				attachmentToken: "attachment-a",
				projectionRevision: 8n,
				throughOutputSeq: 12n,
			}),
		).toBe(true);
	});

	it("retires only one same-baseline handoff per Host output step", () => {
		const paint = {
			attachmentToken: "attachment-a",
			projectionRevision: 8n,
			throughOutputSeq: 12n,
		};
		const first = {
			text: "지",
			attachmentToken: "attachment-a",
			baselineProjectionRevision: 7n,
			baselineThroughOutputSeq: 11n,
			writtenToPty: false,
		};
		const second = { ...first, text: "금", writtenToPty: true };
		const blocked = [first, second] as const;
		expect(retirePaintedTerminalCompositionHandoffs(blocked, paint)).toBe(
			blocked,
		);
		expect(
			retirePaintedTerminalCompositionHandoffs(
				[{ ...first, writtenToPty: true }, second],
				paint,
			),
		).toEqual([
			{
				...second,
				baselineThroughOutputSeq: 12n,
			},
		]);
	});

	it("retires exact same-baseline handoffs from one coalesced Host output", () => {
		const handoff = {
			attachmentToken: "attachment-a",
			baselineProjectionRevision: 7n,
			baselineThroughOutputSeq: 11n,
			inputBaselineOutputSequence: 11n,
			writtenToPty: true,
		};
		expect(
			retirePaintedTerminalCompositionHandoffs([handoff, handoff], {
				attachmentToken: "attachment-a",
				projectionRevision: 8n,
				throughOutputSeq: 12n,
			}),
		).toEqual([]);
	});

	it("keeps an exact handoff whose Host write followed the painted output", () => {
		const first = {
			attachmentToken: "attachment-a",
			baselineProjectionRevision: 7n,
			baselineThroughOutputSeq: 11n,
			inputBaselineOutputSequence: 11n,
			writtenToPty: true,
		};
		const second = {
			...first,
			inputBaselineOutputSequence: 12n,
		};
		const remaining = retirePaintedTerminalCompositionHandoffs(
			[first, second],
			{
				attachmentToken: "attachment-a",
				projectionRevision: 8n,
				throughOutputSeq: 12n,
			},
		);
		expect(remaining).toEqual([{ ...second, baselineThroughOutputSeq: 12n }]);
		expect(
			retirePaintedTerminalCompositionHandoffs(remaining, {
				attachmentToken: "attachment-a",
				projectionRevision: 9n,
				throughOutputSeq: 13n,
			}),
		).toEqual([]);
	});

	it("retires a ready same-baseline prefix when one paint coalesces its output steps", () => {
		const handoff = {
			attachmentToken: "attachment-a",
			baselineProjectionRevision: 7n,
			baselineThroughOutputSeq: 11n,
			writtenToPty: true,
		};
		expect(
			retirePaintedTerminalCompositionHandoffs([handoff, handoff, handoff], {
				attachmentToken: "attachment-a",
				projectionRevision: 8n,
				throughOutputSeq: 14n,
			}),
		).toEqual([]);
	});

	it("uses only Host output baselines to distinguish successor capacity", () => {
		const first = {
			attachmentToken: "attachment-a",
			baselineProjectionRevision: 7n,
			baselineThroughOutputSeq: 11n,
			writtenToPty: true,
		};
		const second = {
			...first,
			baselineProjectionRevision: 8n,
		};
		expect(
			retirePaintedTerminalCompositionHandoffs([first, second], {
				attachmentToken: "attachment-a",
				projectionRevision: 9n,
				throughOutputSeq: 12n,
			}),
		).toEqual([
			{
				...second,
				baselineThroughOutputSeq: 12n,
			},
		]);
	});

	it("converges distinct output-baseline handoffs under one latest paint", () => {
		const first = {
			attachmentToken: "attachment-a",
			baselineProjectionRevision: 7n,
			baselineThroughOutputSeq: 11n,
			writtenToPty: true,
		};
		const second = {
			...first,
			baselineProjectionRevision: 8n,
			baselineThroughOutputSeq: 12n,
		};
		expect(
			retirePaintedTerminalCompositionHandoffs([first, second], {
				attachmentToken: "attachment-a",
				projectionRevision: 9n,
				throughOutputSeq: 13n,
			}),
		).toEqual([]);
	});

	it("accepts the exact receipt after its successor already painted", () => {
		const paint = {
			attachmentToken: "attachment-a",
			projectionRevision: 8n,
			throughOutputSeq: 12n,
		};
		const waiting = {
			text: "지",
			attachmentToken: "attachment-a",
			baselineProjectionRevision: 7n,
			baselineThroughOutputSeq: 11n,
			writtenToPty: false,
		};
		expect(retirePaintedTerminalCompositionHandoffs([waiting], paint)).toEqual([
			waiting,
		]);
		expect(
			retirePaintedTerminalCompositionHandoffs(
				[{ ...waiting, writtenToPty: true }],
				paint,
			),
		).toEqual([]);
	});

	it("consumes a painted successor before retiring the next queued commit", () => {
		const paint = {
			attachmentToken: "attachment-a",
			projectionRevision: 8n,
			throughOutputSeq: 12n,
		};
		const first = {
			text: "지",
			attachmentToken: "attachment-a",
			baselineProjectionRevision: 7n,
			baselineThroughOutputSeq: 11n,
			writtenToPty: true,
		};
		const second = { ...first, text: "금", writtenToPty: false };
		const [remaining] = retirePaintedTerminalCompositionHandoffs(
			[first, second],
			paint,
		);

		expect(remaining).toEqual({
			...second,
			baselineThroughOutputSeq: 12n,
		});
		const acknowledged = { ...remaining, writtenToPty: true };
		expect(
			retirePaintedTerminalCompositionHandoffs([acknowledged], paint),
		).toEqual([acknowledged]);
		expect(
			retirePaintedTerminalCompositionHandoffs([acknowledged], {
				...paint,
				projectionRevision: 9n,
				throughOutputSeq: 13n,
			}),
		).toEqual([]);
	});

	it("uses a late exact receipt against the immutable commit projection", () => {
		const paint = {
			attachmentToken: "attachment-a",
			projectionRevision: 8n,
			throughOutputSeq: 12n,
		};
		const first = {
			text: "지",
			attachmentToken: "attachment-a",
			baselineProjectionRevision: 7n,
			baselineThroughOutputSeq: 11n,
			inputBaselineOutputSequence: 11n,
			writtenToPty: true,
		};
		const second = {
			...first,
			text: "금",
			inputBaselineOutputSequence: undefined,
			writtenToPty: false,
		};
		const [waiting] = retirePaintedTerminalCompositionHandoffs(
			[first, second],
			paint,
		);
		expect(waiting).toEqual({
			...second,
			baselineThroughOutputSeq: 12n,
		});
		if (!waiting) throw new Error("second handoff must remain queued");
		expect(
			retirePaintedTerminalCompositionHandoffs(
				[
					{
						...waiting,
						writtenToPty: true,
						inputBaselineOutputSequence: 11n,
					},
				],
				paint,
			),
		).toEqual([]);
	});
});
