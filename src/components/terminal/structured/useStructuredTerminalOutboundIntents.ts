/**
 * 이 pane이 Host 로 **내보내는** 것 전부 — 바이트 한 벌과 그에 딸린 영수증
 * 장부.
 *
 * 트랜스포트 훅에서 갈라져 나온 이유는 세 함수가 한 규칙을 공유하기 때문이다:
 * 레코드를 보내기 직전과 보내는 순간에 **같은 attachment 인지** 다시 확인하고,
 * 실패하면 이미 발급한 영수증을 정확히 그만큼 취소한다. 확인을 한 번 빠뜨리면
 * 죽은 attachment 의 시퀀스로 살아 있는 세션에 쓰게 되고, 취소를 빠뜨리면
 * 영원히 도착하지 않을 영수증을 기다린다. 규칙이 한 파일에 있어야 셋이 같이
 * 지킨다.
 *
 * viewport intent 만 `viewportDispatchTail` 로 줄을 세운다 — Host 의
 * `intent_seq` 는 순서가 엄격해서, 네이티브 admission 을 기다리지 않고 보내면
 * 뒤 것이 앞 것을 앞지른다. 입력은 그 제약이 없으므로 줄을 서지 않는다.
 */

import type { MutableRefObject } from "react";
import { useCallback } from "react";
import { hmux } from "@/lib/ipc";
import type { InstalledTerminalViewportFrame } from "@/lib/terminal/state/structuredTerminalViewport";
import { terminalViewportInputFence } from "@/lib/terminal/state/structuredTerminalViewport";
import type { TerminalInputFence } from "@/lib/terminal/state/terminalInputIntent";
import {
	cancelTerminalIntentReceipt,
	issueTerminalIntentReceipt,
	issueTerminalUserInputReceipt,
	type TerminalIntentReceiptKind,
	terminalIntentReceiptPendingKinds,
} from "@/lib/terminal/state/terminalIntentReceiptSequence";
import { TERMINAL_STATE_BASE_PROTOCOL_MINOR } from "@/lib/terminal/protocol/terminalStateProtocol";
import {
	issueTerminalViewportIntent,
	type TerminalViewportFrameReplica,
	type TerminalViewportIntentFence,
} from "@/lib/terminal/state/terminalViewportFrameReplica";
import { encodeTerminalViewportRowsIntent } from "@/lib/terminal/state/terminalViewportIntent";
import { isRetiredStructuredTerminalAttachment } from "@/lib/terminal/structuredTerminalUpstreamFailure";
import type {
	RecoverableAttachmentFailureOrigin,
	StructuredTerminalAttachmentIdentity,
	TerminalResizeReceiptCallbacks,
	UpstreamSequence,
	ViewportIntentInputFence,
} from "./structuredTerminalViewportTransportContract";

export interface StructuredTerminalOutboundIntents {
	readonly sendInput: (
		encode: (recordId: bigint, fence: TerminalInputFence) => Uint8Array,
		receiptKind?: TerminalIntentReceiptKind,
		receiptCallbacks?: TerminalResizeReceiptCallbacks,
		onTransportConfirmed?: () => void,
	) => bigint | undefined;
	readonly sendViewportIntent: (
		encode: (
			recordId: bigint,
			inputFence: ViewportIntentInputFence,
			viewportFence: TerminalViewportIntentFence,
		) => Uint8Array,
		receiptKind?: "wheel",
	) => bigint | undefined;
	readonly requestViewportRows: (rows: number) => bigint | undefined;
}

export function useStructuredTerminalOutboundIntents({
	isCurrentAttachment,
	observerIdRef,
	reportAttachmentFailure,
	reportFailureForAttachment,
	reportRecoverableFailure,
	replicaRef,
	upstreamSequenceRef,
}: {
	isCurrentAttachment: (
		attachment: StructuredTerminalAttachmentIdentity,
		requireAttached?: boolean,
	) => boolean;
	observerIdRef: MutableRefObject<string | undefined>;
	reportAttachmentFailure: (
		attachment: StructuredTerminalAttachmentIdentity,
		cause: unknown,
		retired: boolean,
	) => void;
	reportFailureForAttachment: (
		attachment: StructuredTerminalAttachmentIdentity,
		cause: unknown,
	) => void;
	reportRecoverableFailure: (
		attachment: StructuredTerminalAttachmentIdentity,
		origin: RecoverableAttachmentFailureOrigin,
		cause: unknown,
	) => void;
	replicaRef: MutableRefObject<
		TerminalViewportFrameReplica<InstalledTerminalViewportFrame>
	>;
	upstreamSequenceRef: MutableRefObject<UpstreamSequence | undefined>;
}): StructuredTerminalOutboundIntents {
	const sendEncoded = useCallback(
		(
			sequence: UpstreamSequence,
			encoded: Uint8Array,
			onFailure?: () => void,
			recoverableFailureOrigin?: RecoverableAttachmentFailureOrigin,
			orderedViewportIntent = false,
			onTransportConfirmed?: () => void,
		) => {
			const { observerId, attachment } = sequence;
			if (
				sequence.failed ||
				upstreamSequenceRef.current !== sequence ||
				!isCurrentAttachment(attachment, true)
			) {
				onFailure?.();
				return;
			}
			const fail = (cause: unknown) => {
				const pendingBeforeFailure = recoverableFailureOrigin
					? terminalIntentReceiptPendingKinds(sequence.receipts)
					: undefined;
				onFailure?.();
				if (sequence.failed) return;
				if (!isCurrentAttachment(attachment, true)) return;
				if (recoverableFailureOrigin && !pendingBeforeFailure?.input) {
					reportRecoverableFailure(attachment, recoverableFailureOrigin, cause);
				} else {
					reportAttachmentFailure(
						attachment,
						cause,
						isRetiredStructuredTerminalAttachment(cause),
					);
				}
			};
			const dispatch = (): Promise<void> => {
				if (
					sequence.failed ||
					upstreamSequenceRef.current !== sequence ||
					!isCurrentAttachment(attachment, true)
				) {
					onFailure?.();
					return Promise.resolve();
				}
				try {
					return hmux
						.sendStructuredTerminalRecord(observerId, encoded)
						.then(() => onTransportConfirmed?.(), fail);
				} catch (cause) {
					fail(cause);
					return Promise.resolve();
				}
			};
			if (orderedViewportIntent) {
				const queued = sequence.viewportDispatchTail.then(dispatch);
				sequence.viewportDispatchTail = queued.catch(() => undefined);
				return;
			}
			void dispatch();
		},
		[
			isCurrentAttachment,
			reportAttachmentFailure,
			reportRecoverableFailure,
			upstreamSequenceRef,
		],
	);

	const sendInput = useCallback(
		(
			encode: (recordId: bigint, fence: TerminalInputFence) => Uint8Array,
			receiptKind: TerminalIntentReceiptKind = "input",
			receiptCallbacks?: TerminalResizeReceiptCallbacks,
			onTransportConfirmed?: () => void,
			origin: "user" | "surface" = "surface",
		) => {
			const observerId = observerIdRef.current;
			const sequence = upstreamSequenceRef.current;
			const current = replicaRef.current;
			const fence = terminalViewportInputFence(current);
			if (
				!observerId ||
				!sequence ||
				sequence.observerId !== observerId ||
				!isCurrentAttachment(sequence.attachment, true) ||
				fence === null
			) {
				return;
			}
			try {
				const recordId = sequence.nextRecordId;
				const encoded = encode(recordId, fence);
				if (receiptKind === "input" && origin === "user") {
					issueTerminalUserInputReceipt(sequence.receipts, recordId);
				} else {
					issueTerminalIntentReceipt(
						sequence.receipts,
						receiptKind,
						recordId,
						receiptKind === "resize" ? receiptCallbacks : undefined,
					);
				}
				sequence.nextRecordId += 1n;
				sendEncoded(
					sequence,
					encoded,
					() => {
						cancelTerminalIntentReceipt(
							sequence.receipts,
							receiptKind,
							recordId,
						);
					},
					receiptKind === "resize" ? "transport_send_resize" : undefined,
					false,
					onTransportConfirmed,
				);
				return recordId;
			} catch (cause) {
				if (sequence) reportFailureForAttachment(sequence.attachment, cause);
				return undefined;
			}
		},
		[
			isCurrentAttachment,
			observerIdRef,
			replicaRef,
			reportFailureForAttachment,
			sendEncoded,
			upstreamSequenceRef,
		],
	);

	const sendViewportIntent = useCallback(
		(
			encode: (
				recordId: bigint,
				inputFence: ViewportIntentInputFence,
				viewportFence: TerminalViewportIntentFence,
			) => Uint8Array,
			receiptKind?: "wheel",
		) => {
			const observerId = observerIdRef.current;
			const sequence = upstreamSequenceRef.current;
			const current = replicaRef.current;
			if (
				!observerId ||
				!sequence ||
				sequence.observerId !== observerId ||
				!isCurrentAttachment(sequence.attachment, true) ||
				current.attachmentId !== observerId ||
				current.terminalEpoch === null
			) {
				return;
			}
			try {
				const issued = issueTerminalViewportIntent(current);
				const recordId = sequence.nextRecordId;
				const encoded = encode(
					recordId,
					{
						schemaMinor: TERMINAL_STATE_BASE_PROTOCOL_MINOR,
						terminalEpoch: current.terminalEpoch,
						throughOutputSeq: current.throughOutputSeq,
						stateRevision: current.stateRevision,
					},
					issued.fence,
				);
				replicaRef.current = issued.replica;
				if (receiptKind) {
					issueTerminalIntentReceipt(sequence.receipts, receiptKind, recordId);
				}
				sequence.nextRecordId += 1n;
				sendEncoded(
					sequence,
					encoded,
					() => {
						if (receiptKind) {
							cancelTerminalIntentReceipt(
								sequence.receipts,
								receiptKind,
								recordId,
							);
						}
					},
					"transport_send_viewport",
					true,
				);
				return issued.fence.intentSeq;
			} catch (cause) {
				if (sequence) reportFailureForAttachment(sequence.attachment, cause);
				return undefined;
			}
		},
		[
			isCurrentAttachment,
			observerIdRef,
			replicaRef,
			reportFailureForAttachment,
			sendEncoded,
			upstreamSequenceRef,
		],
	);

	const requestViewportRows = useCallback(
		(rows: number) =>
			sendViewportIntent((recordId, inputFence, viewportFence) =>
				encodeTerminalViewportRowsIntent(
					recordId,
					inputFence,
					viewportFence,
					rows,
				),
			),
		[sendViewportIntent],
	);

	return { sendInput, sendViewportIntent, requestViewportRows };
}
