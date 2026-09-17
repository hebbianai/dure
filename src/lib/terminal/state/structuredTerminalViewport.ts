import type {
	InputReceipt,
	ResizeReceipt,
	TerminalEvent,
	ViewportFrame,
	WheelReceipt,
} from "@/contracts/terminalStateProtocol";
import type { TerminalInputFence } from "./terminalInputIntent";
import type { DecodedTerminalStateRecord } from "../protocol/terminalStateProtocol";
import {
	createTerminalViewportFrameReplica,
	reduceTerminalViewportFrame,
	type TerminalViewportFrameReduction,
	type TerminalViewportFrameReplica,
} from "./terminalViewportFrameReplica";

export interface InstalledTerminalViewportFrame {
	readonly schemaMinor: number;
	readonly frame: ViewportFrame;
}

export type StructuredTerminalViewportRecordReduction =
	| TerminalViewportFrameReduction<InstalledTerminalViewportFrame>
	| {
			readonly status: "receipt";
			readonly terminalEpoch: string;
			readonly receipt:
				| { readonly kind: "input"; readonly value: InputReceipt }
				| { readonly kind: "resize"; readonly value: ResizeReceipt }
				| { readonly kind: "wheel"; readonly value: WheelReceipt };
	  }
	| {
			readonly status: "event";
			readonly terminalEpoch: string;
			readonly event: TerminalEvent;
	  }
	| { readonly status: "invalid"; readonly reason: string };

export function primeStructuredTerminalViewport(
	attachmentId: string,
	receipt: {
		readonly terminalEpoch: string;
		readonly throughOutputSeq: string;
		readonly stateRevision: string;
	},
): TerminalViewportFrameReplica<InstalledTerminalViewportFrame> {
	return createTerminalViewportFrameReplica(attachmentId, {
		terminalEpoch: receipt.terminalEpoch,
		throughOutputSeq: BigInt(receipt.throughOutputSeq),
		stateRevision: BigInt(receipt.stateRevision),
	});
}

export function reduceStructuredTerminalViewportRecord(
	replica: TerminalViewportFrameReplica<InstalledTerminalViewportFrame>,
	attachmentId: string,
	decoded: DecodedTerminalStateRecord,
): StructuredTerminalViewportRecordReduction {
	if (decoded.record.body.case === "event") {
		return {
			status: "event",
			terminalEpoch: decoded.record.terminalEpoch,
			event: decoded.record.body.value,
		};
	}
	if (decoded.record.body.case === "inputReceipt") {
		return {
			status: "receipt",
			terminalEpoch: decoded.record.terminalEpoch,
			receipt: { kind: "input", value: decoded.record.body.value },
		};
	}
	if (decoded.record.body.case === "resizeReceipt") {
		return {
			status: "receipt",
			terminalEpoch: decoded.record.terminalEpoch,
			receipt: { kind: "resize", value: decoded.record.body.value },
		};
	}
	if (decoded.record.body.case === "wheelReceipt") {
		return {
			status: "receipt",
			terminalEpoch: decoded.record.terminalEpoch,
			receipt: { kind: "wheel", value: decoded.record.body.value },
		};
	}
	if (decoded.record.body.case !== "viewportFrame") {
		return {
			status: "invalid",
			reason: "structured terminal expected a complete viewport frame",
		};
	}
	const frame = decoded.record.body.value;
	return reduceTerminalViewportFrame(replica, {
		attachmentId,
		terminalEpoch: decoded.record.terminalEpoch,
		stateRevision: decoded.record.stateRevision,
		throughOutputSeq: decoded.record.throughOutputSeq,
		projectionRevision: frame.projectionRevision,
		damageBaseProjectionRevision: frame.damageBaseProjectionRevision,
		appliedIntentSeq: frame.appliedIntentSeq,
		frame: { schemaMinor: decoded.record.schemaMinor, frame },
	});
}

export function terminalViewportInputFence(
	replica: TerminalViewportFrameReplica<InstalledTerminalViewportFrame>,
): TerminalInputFence | null {
	if (replica.terminalEpoch === null || replica.frame === null) return null;
	return {
		schemaMinor: replica.frame.schemaMinor,
		terminalEpoch: replica.terminalEpoch,
		throughOutputSeq: replica.throughOutputSeq,
		stateRevision: replica.stateRevision,
	};
}
