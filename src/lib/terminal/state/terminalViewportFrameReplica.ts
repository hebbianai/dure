export interface TerminalViewportFrameCandidate<TFrame> {
	readonly attachmentId: string;
	readonly terminalEpoch: string;
	readonly stateRevision: bigint;
	readonly throughOutputSeq: bigint;
	readonly projectionRevision: bigint;
	readonly damageBaseProjectionRevision: bigint;
	readonly appliedIntentSeq: bigint;
	readonly frame: TFrame;
}

export interface TerminalViewportFrameReplica<TFrame> {
	readonly attachmentId: string;
	readonly terminalEpoch: string | null;
	readonly stateRevision: bigint;
	readonly throughOutputSeq: bigint;
	readonly projectionRevision: bigint;
	readonly issuedIntentSeq: bigint;
	readonly appliedIntentSeq: bigint;
	readonly frame: TFrame | null;
}

export interface TerminalViewportAttachmentFence {
	readonly terminalEpoch: string;
	readonly stateRevision: bigint;
	readonly throughOutputSeq: bigint;
}

export type TerminalViewportFrameReduction<TFrame> =
	| {
			readonly status: "applied";
			readonly paint: "full" | "damage";
			readonly replica: TerminalViewportFrameReplica<TFrame>;
	  }
	| {
			readonly status: "duplicate" | "stale_attachment" | "reattach_required";
			readonly replica: TerminalViewportFrameReplica<TFrame>;
			readonly reason?: string;
	  };

export interface TerminalViewportIntentFence {
	readonly attachmentId: string;
	readonly intentSeq: bigint;
	readonly observedProjectionRevision: bigint;
}

const MAX_UINT64 = (1n << 64n) - 1n;

export function createTerminalViewportFrameReplica<TFrame>(
	attachmentId: string,
	fence?: TerminalViewportAttachmentFence,
): TerminalViewportFrameReplica<TFrame> {
	if (
		attachmentId.length === 0 ||
		(fence !== undefined &&
			(fence.terminalEpoch.length === 0 ||
				!validUint64(fence.stateRevision) ||
				fence.stateRevision === 0n ||
				!validUint64(fence.throughOutputSeq)))
	) {
		throw new Error("terminal viewport attachment fence is invalid");
	}
	return {
		attachmentId,
		terminalEpoch: fence?.terminalEpoch ?? null,
		stateRevision: fence?.stateRevision ?? 0n,
		throughOutputSeq: fence?.throughOutputSeq ?? 0n,
		projectionRevision: 0n,
		issuedIntentSeq: 0n,
		appliedIntentSeq: 0n,
		frame: null,
	};
}

export function issueTerminalViewportIntent<TFrame>(
	replica: TerminalViewportFrameReplica<TFrame>,
): {
	readonly replica: TerminalViewportFrameReplica<TFrame>;
	readonly fence: TerminalViewportIntentFence;
} {
	if (replica.issuedIntentSeq === MAX_UINT64) {
		throw new Error("terminal viewport intent sequence is exhausted");
	}
	const intentSeq = replica.issuedIntentSeq + 1n;
	return {
		replica: { ...replica, issuedIntentSeq: intentSeq },
		fence: {
			attachmentId: replica.attachmentId,
			intentSeq,
			observedProjectionRevision: replica.projectionRevision,
		},
	};
}

export function reduceTerminalViewportFrame<TFrame>(
	replica: TerminalViewportFrameReplica<TFrame>,
	candidate: TerminalViewportFrameCandidate<TFrame>,
): TerminalViewportFrameReduction<TFrame> {
	if (candidate.attachmentId !== replica.attachmentId) {
		return { status: "stale_attachment", replica };
	}
	if (
		candidate.terminalEpoch.length === 0 ||
		!validUint64(candidate.stateRevision) ||
		!validUint64(candidate.throughOutputSeq) ||
		!validUint64(candidate.projectionRevision) ||
		!validUint64(candidate.damageBaseProjectionRevision) ||
		!validUint64(candidate.appliedIntentSeq) ||
		candidate.projectionRevision === 0n
	) {
		return {
			status: "reattach_required",
			replica,
			reason: "terminal viewport frame contains an invalid fence",
		};
	}
	if (replica.terminalEpoch !== null) {
		if (candidate.terminalEpoch !== replica.terminalEpoch) {
			return {
				status: "reattach_required",
				replica,
				reason: "terminal viewport epoch changed inside one attachment",
			};
		}
		if (candidate.projectionRevision <= replica.projectionRevision) {
			return { status: "duplicate", replica };
		}
		if (
			candidate.stateRevision < replica.stateRevision ||
			candidate.throughOutputSeq < replica.throughOutputSeq ||
			candidate.appliedIntentSeq < replica.appliedIntentSeq
		) {
			return {
				status: "reattach_required",
				replica,
				reason: "terminal viewport frame high-water moved backward",
			};
		}
	}
	if (candidate.appliedIntentSeq > replica.issuedIntentSeq) {
		return {
			status: "reattach_required",
			replica,
			reason: "terminal viewport frame acknowledged an unissued intent",
		};
	}
	const paint =
		replica.frame !== null &&
		candidate.damageBaseProjectionRevision === replica.projectionRevision
			? "damage"
			: "full";
	return {
		status: "applied",
		paint,
		replica: {
			...replica,
			terminalEpoch: candidate.terminalEpoch,
			stateRevision: candidate.stateRevision,
			throughOutputSeq: candidate.throughOutputSeq,
			projectionRevision: candidate.projectionRevision,
			appliedIntentSeq: candidate.appliedIntentSeq,
			frame: candidate.frame,
		},
	};
}

function validUint64(value: bigint): boolean {
	return value >= 0n && value <= MAX_UINT64;
}
