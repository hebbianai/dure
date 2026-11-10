import { describe, expect, it } from "vitest";
import { FindStep } from "@/contracts/terminalStateProtocol";
import { decodeTerminalStateRecord } from "../protocol/terminalStateProtocol";
import {
	encodeTerminalDefaultColorsIntent,
	encodeTerminalFindIntent,
	encodeTerminalViewportFollowTailIntent,
} from "./terminalViewportIntent";

it("fences return-to-bottom as a viewport intent, not terminal input", () => {
	const decoded = decodeTerminalStateRecord(
		encodeTerminalViewportFollowTailIntent(
			18n,
			{
				schemaMinor: 4,
				terminalEpoch: "terminal-a",
				throughOutputSeq: 9n,
				stateRevision: 11n,
			},
			{
				attachmentId: "attachment-a",
				observedProjectionRevision: 13n,
				intentSeq: 4n,
			},
		),
	);
	expect(decoded.metadata).toMatchObject({
		recordId: 18n,
		kind: "viewport_intent",
	});
	expect(decoded.record).toMatchObject({
		terminalEpoch: "terminal-a",
		throughOutputSeq: 9n,
		stateRevision: 11n,
		body: {
			case: "viewportIntent",
			value: {
				observedProjectionRevision: 13n,
				intentSeq: 4n,
				intent: { case: "followTail" },
			},
		},
	});
});

describe("encodeTerminalDefaultColorsIntent", () => {
	it("uses minor 6 while preserving the current terminal and projection fences", () => {
		const decoded = decodeTerminalStateRecord(
			encodeTerminalDefaultColorsIntent(
				17n,
				{
					schemaMinor: 4,
					terminalEpoch: "terminal-a",
					throughOutputSeq: 9n,
					stateRevision: 11n,
				},
				{
					attachmentId: "attachment-a",
					observedProjectionRevision: 13n,
					intentSeq: 3n,
				},
				{ foregroundRgb: 0x123456, backgroundRgb: 0x654321 },
			),
		);

		expect(decoded.metadata).toMatchObject({
			protocolMinor: 6,
			recordId: 17n,
			kind: "viewport_intent",
		});
		expect(decoded.record).toMatchObject({
			schemaMinor: 6,
			terminalEpoch: "terminal-a",
			throughOutputSeq: 9n,
			stateRevision: 11n,
			body: {
				case: "viewportIntent",
				value: {
					observedProjectionRevision: 13n,
					intentSeq: 3n,
					intent: {
						case: "terminalDefaultColors",
						value: {
							foregroundRgb: 0x123456,
							backgroundRgb: 0x654321,
						},
					},
				},
			},
		});
	});
});

describe("encodeTerminalFindIntent", () => {
	const inputFence = {
		schemaMinor: 4,
		terminalEpoch: "terminal-a",
		throughOutputSeq: 9n,
		stateRevision: 11n,
	};
	const viewportFence = {
		attachmentId: "attachment-a",
		observedProjectionRevision: 13n,
		intentSeq: 5n,
	};

	it("uses minor 7 and carries the query, options and step", () => {
		const decoded = decodeTerminalStateRecord(
			encodeTerminalFindIntent(19n, inputFence, viewportFence, {
				query: "error: .*",
				caseSensitive: true,
				regex: true,
				step: FindStep.OLDER,
			}),
		);
		expect(decoded.metadata).toMatchObject({ protocolMinor: 7, recordId: 19n });
		expect(decoded.record).toMatchObject({
			schemaMinor: 7,
			body: {
				case: "viewportIntent",
				value: {
					observedProjectionRevision: 13n,
					intentSeq: 5n,
					intent: {
						case: "findInHistory",
						value: {
							query: "error: .*",
							caseSensitive: true,
							regex: true,
							step: FindStep.OLDER,
						},
					},
				},
			},
		});
	});

	it("rejects a query over the Host's byte bound before sending", () => {
		expect(() =>
			encodeTerminalFindIntent(20n, inputFence, viewportFence, {
				query: "가".repeat(400),
				caseSensitive: false,
				regex: false,
				step: FindStep.RESTART,
			}),
		).toThrow(/history find/);
	});
});
