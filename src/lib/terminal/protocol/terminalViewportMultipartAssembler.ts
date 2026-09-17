import { create } from "@bufbuild/protobuf";
import { TerminalStateRecordSchema } from "../../../contracts/terminalStateProtocol";
import {
	type DecodedTerminalStateRecord,
	decodeTerminalStateRecord,
} from "./terminalStateProtocol";
import { validateTerminalSurfaceRecord } from "./terminalStateSemanticValidation";
import { TerminalViewportFrameDecoder } from "./terminalViewportFrameDecoder";

const VIEWPORT_FRAME_PROTOCOL_MINOR = 4;
const MAX_UINT64 = 0xffff_ffff_ffff_ffffn;

export type TerminalViewportMultipartAssembly =
	| { readonly status: "pending" }
	| {
			readonly status: "downstream";
			readonly decoded: DecodedTerminalStateRecord;
	  }
	| {
			readonly status: "complete";
			readonly decoded: DecodedTerminalStateRecord;
	  }
	| { readonly status: "resync_required"; readonly reason: string };

export interface TerminalViewportMultipartAssembler {
	push(encoded: Uint8Array): TerminalViewportMultipartAssembly;
	hasIncomplete(): boolean;
	discardIncomplete(): boolean;
}

interface InstalledViewportFrame {
	readonly terminalEpoch: string;
	readonly throughOutputSeq: bigint;
	readonly stateRevision: bigint;
	readonly projectionRevision: bigint;
	readonly appliedIntentSeq: bigint;
}

interface PendingViewportFrame extends InstalledViewportFrame {
	readonly protocolMinor: number;
	readonly schemaMinor: number;
	readonly batchId: Uint8Array;
	readonly partCount: number;
	readonly frameBytes: Uint8Array;
	nextPartIndex: number;
	nextRecordId: bigint;
	lastRecordId: bigint;
	byteLength: number;
}

class BoundedTerminalViewportMultipartAssembler
	implements TerminalViewportMultipartAssembler
{
	private pending: PendingViewportFrame | undefined;
	private installed: InstalledViewportFrame | undefined;
	private readonly viewportFrames = new TerminalViewportFrameDecoder();

	push(encoded: Uint8Array): TerminalViewportMultipartAssembly {
		let decoded: DecodedTerminalStateRecord;
		try {
			decoded = decodeTerminalStateRecord(encoded, this.viewportFrames);
		} catch (cause) {
			return this.resync(
				cause instanceof Error
					? cause.message
					: "terminal state record could not be decoded",
			);
		}
		const delivery = this.pushDecoded(decoded);
		if (
			delivery.status === "downstream" &&
			decoded.record.body.case === "viewportFrame"
		) {
			this.viewportFrames.commit();
		} else {
			this.viewportFrames.discard();
		}
		return delivery;
	}

	hasIncomplete(): boolean {
		return this.pending !== undefined;
	}

	discardIncomplete(): boolean {
		const discarded = this.pending !== undefined;
		this.pending = undefined;
		return discarded;
	}

	private pushDecoded(
		decoded: DecodedTerminalStateRecord,
	): TerminalViewportMultipartAssembly {
		if (
			decoded.record.body.case === "inputIntent" ||
			decoded.record.body.case === "viewportIntent"
		) {
			return this.resync("upstream input is invalid downstream");
		}
		if (decoded.record.body.case !== "viewportFramePart") {
			if (this.pending !== undefined) {
				return this.resync(
					"viewport frame batch was interrupted by another record",
				);
			}
			if (decoded.record.body.case === "viewportFrame") {
				this.installed = {
					terminalEpoch: decoded.record.terminalEpoch,
					throughOutputSeq: decoded.record.throughOutputSeq,
					stateRevision: decoded.record.stateRevision,
					projectionRevision: decoded.record.body.value.projectionRevision,
					appliedIntentSeq: decoded.record.body.value.appliedIntentSeq,
				};
			}
			return { status: "downstream", decoded };
		}

		const part = decoded.record.body.value;
		if (this.pending === undefined) {
			if (part.partIndex !== 0) {
				return this.resync("viewport frame first part is missing");
			}
			if (this.installed !== undefined) {
				if (this.installed.terminalEpoch !== decoded.record.terminalEpoch) {
					return this.resync("viewport frame terminal epoch changed");
				}
				if (
					part.projectionRevision <= this.installed.projectionRevision ||
					decoded.record.stateRevision < this.installed.stateRevision ||
					decoded.record.throughOutputSeq < this.installed.throughOutputSeq ||
					part.appliedIntentSeq < this.installed.appliedIntentSeq
				) {
					return this.resync("viewport frame part is duplicate or stale");
				}
			}
			this.pending = {
				protocolMinor: decoded.metadata.protocolMinor,
				schemaMinor: decoded.record.schemaMinor,
				terminalEpoch: decoded.record.terminalEpoch,
				throughOutputSeq: decoded.record.throughOutputSeq,
				stateRevision: decoded.record.stateRevision,
				batchId: part.batchId.slice(),
				partCount: part.partCount,
				// The decoded part already satisfies the protocol's frame byte cap.
				frameBytes: new Uint8Array(part.totalFrameBytes),
				projectionRevision: part.projectionRevision,
				appliedIntentSeq: part.appliedIntentSeq,
				nextPartIndex: 0,
				nextRecordId: decoded.metadata.recordId,
				lastRecordId: decoded.metadata.recordId,
				byteLength: 0,
			};
		}

		const pending = this.pending;
		if (
			pending.protocolMinor !== decoded.metadata.protocolMinor ||
			pending.schemaMinor !== decoded.record.schemaMinor ||
			pending.terminalEpoch !== decoded.record.terminalEpoch ||
			pending.throughOutputSeq !== decoded.record.throughOutputSeq ||
			pending.stateRevision !== decoded.record.stateRevision ||
			pending.batchId.byteLength !== part.batchId.byteLength ||
			pending.batchId.some((byte, index) => byte !== part.batchId[index]) ||
			pending.partCount !== part.partCount ||
			pending.frameBytes.byteLength !== part.totalFrameBytes ||
			pending.projectionRevision !== part.projectionRevision ||
			pending.appliedIntentSeq !== part.appliedIntentSeq ||
			pending.nextPartIndex !== part.partIndex ||
			pending.nextRecordId !== decoded.metadata.recordId
		) {
			return this.resync(
				"viewport frame part is duplicate, reordered, or replaced",
			);
		}
		if (
			pending.byteLength + part.frameChunk.byteLength >
			pending.frameBytes.byteLength
		) {
			return this.resync("viewport frame parts exceed declared total");
		}
		pending.frameBytes.set(part.frameChunk, pending.byteLength);
		pending.byteLength += part.frameChunk.byteLength;
		pending.nextPartIndex += 1;
		pending.lastRecordId = decoded.metadata.recordId;
		if (pending.nextPartIndex < pending.partCount) {
			if (pending.nextRecordId === MAX_UINT64) {
				return this.resync("viewport frame record id sequence is exhausted");
			}
			pending.nextRecordId += 1n;
			return { status: "pending" };
		}

		this.pending = undefined;
		if (pending.byteLength !== pending.frameBytes.byteLength) {
			return {
				status: "resync_required",
				reason: "viewport frame parts do not match declared total",
			};
		}
		try {
			const frame = this.viewportFrames.decode(pending.frameBytes);
			if (
				frame.projectionRevision !== pending.projectionRevision ||
				frame.appliedIntentSeq !== pending.appliedIntentSeq
			) {
				return {
					status: "resync_required",
					reason: "reassembled viewport frame disagrees with part fences",
				};
			}
			const record = create(TerminalStateRecordSchema, {
				schemaMinor: VIEWPORT_FRAME_PROTOCOL_MINOR,
				terminalEpoch: pending.terminalEpoch,
				throughOutputSeq: pending.throughOutputSeq,
				stateRevision: pending.stateRevision,
				body: { case: "viewportFrame", value: frame },
			});
			validateTerminalSurfaceRecord(record);
			this.viewportFrames.commit();
			const decoded: DecodedTerminalStateRecord = {
				metadata: {
					protocolMinor: VIEWPORT_FRAME_PROTOCOL_MINOR,
					recordId: pending.lastRecordId,
					kind: "viewport_frame",
				},
				record,
			};
			this.installed = {
				terminalEpoch: pending.terminalEpoch,
				throughOutputSeq: pending.throughOutputSeq,
				stateRevision: pending.stateRevision,
				projectionRevision: pending.projectionRevision,
				appliedIntentSeq: pending.appliedIntentSeq,
			};
			return { status: "complete", decoded };
		} catch (cause) {
			this.viewportFrames.discard();
			return {
				status: "resync_required",
				reason:
					cause instanceof Error
						? `reassembled viewport frame protobuf is invalid: ${cause.message}`
						: "reassembled viewport frame protobuf is invalid",
			};
		}
	}

	private resync(reason: string): TerminalViewportMultipartAssembly {
		this.pending = undefined;
		return { status: "resync_required", reason };
	}
}

export function createTerminalViewportMultipartAssembler(): TerminalViewportMultipartAssembler {
	return new BoundedTerminalViewportMultipartAssembler();
}
