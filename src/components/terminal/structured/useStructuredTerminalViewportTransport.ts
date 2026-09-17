import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useWorkspaceRuntimeDesktopId } from "@/components/workspace/WorkspaceRuntimeContext";
import { observeStructuredPaneClose } from "@/lib/terminal/structuredPaneCloseLifetime";
import { managedLocalRuntimeLiveness } from "@/lib/terminal/hmuxManagedAttachConcurrency";
import type { StructuredAgentRuntimeAttachmentFence } from "@/lib/agents/structuredAgentRuntimeProjection";
import { hmux } from "@/lib/ipc";
import {
	admitTerminalPresentation,
	createTerminalPresentationQueue,
} from "@/lib/terminal/presentation/terminalPresentationQueue";
import {
	type InstalledTerminalViewportFrame,
	primeStructuredTerminalViewport,
	reduceStructuredTerminalViewportRecord,
} from "@/lib/terminal/state/structuredTerminalViewport";
import { terminalCarrierClose } from "@/lib/terminal/state/terminalCarrierCloseDisposition";
import { terminalIntentReceiptFailure } from "@/lib/terminal/state/terminalIntentReceiptPolicy";
import {
	acknowledgeTerminalIntentReceipt,
	createTerminalIntentReceiptSequence,
	terminalIntentReceiptPendingKinds,
} from "@/lib/terminal/state/terminalIntentReceiptSequence";
import { runTerminalRecordDelivery } from "@/lib/terminal/state/terminalRecordDelivery";
import type { DecodedTerminalStateRecord } from "@/lib/terminal/protocol/terminalStateProtocol";
import {
	createTerminalViewportEventCursor,
	observeTerminalViewportEventHighWater,
	reduceTerminalViewportEvent,
} from "@/lib/terminal/state/terminalViewportEventCursor";
import {
	createTerminalViewportFrameReplica,
	type TerminalViewportFrameReplica,
} from "@/lib/terminal/state/terminalViewportFrameReplica";
import { decodeHmuxSessionExitReceipt } from "@/lib/terminal/structuredTerminalRecord";
import {
	attachStructuredTerminalRecords,
	type StructuredTerminalCarrierRecord,
	structuredTerminalAttachmentKey,
} from "@/lib/terminal/structuredTerminalRecordAdapter";
import type { TerminalDeliveryTiming } from "@/lib/terminal/terminalDeliveryTimingFacts";
import { useStore } from "@/store";
import { applySemanticProjectionRecord } from "./structuredSemanticProjectionCommit";
import { consumeInitialCarrierRecords } from "./structuredTerminalViewportDelivery";
import { notifyViewportFrame } from "./structuredTerminalViewportFrameReceipt";
import type {
	AttachmentRecoveryHighWater,
	LastGoodTerminalPresentation,
	PendingAttachmentRecoveryFailure,
	PendingResizeReceipt,
	StructuredTerminalAttachmentIdentity,
	StructuredTerminalViewportTransport,
	UpstreamSequence,
	UseStructuredTerminalViewportTransportOptions,
} from "./structuredTerminalViewportTransportContract";
import { useStructuredTerminalAttachmentRecovery } from "./useStructuredTerminalAttachmentRecovery";
import { useStructuredTerminalFailurePresentation } from "./useStructuredTerminalFailurePresentation";
import { useStructuredTerminalOutboundIntents } from "./useStructuredTerminalOutboundIntents";
import { useStructuredTerminalRecoverAttachment } from "./useStructuredTerminalRecoverAttachment";
export function useStructuredTerminalViewportTransport({
	paneApi,
	surfaceId,
	binding,
	presentationRole,
	recoveryAdmission,
	prepareAttach,
	onAttachPhase,
	onAttached,
	onEvent,
	onSessionMetadata,
	onProviderConversationIdentity,
	onWorkingDirectory,
	onInputReceipt,
	onViewportFrameReceived,
	onPaneConnectionState,
	onExit,
	onAttachmentStarted,
	onAttachmentRetired,
	onSurfaceRetirement,
}: UseStructuredTerminalViewportTransportOptions): StructuredTerminalViewportTransport {
	const desktopId = useWorkspaceRuntimeDesktopId();
	const attachmentKey = structuredTerminalAttachmentKey(binding);
	const hostHealthy = useStore((state) =>
		managedLocalRuntimeLiveness(binding, state.hmuxSessionMetadata) === "alive",
	);
	const presentationRoleRef = useRef(presentationRole);
	presentationRoleRef.current = presentationRole;
	const observerIdRef = useRef<string | undefined>(undefined);
	const attachedObserverRef = useRef<string | undefined>(undefined);
	const [replica, setReplica] = useState<
		TerminalViewportFrameReplica<InstalledTerminalViewportFrame>
	>(() => createTerminalViewportFrameReplica(surfaceId));
	const replicaRef = useRef(replica);
	const readLatestCompleteFrame = useCallback(
		() => replicaRef.current.frame,
		[],
	);
	const lastGoodPresentationRef = useRef<LastGoodTerminalPresentation | null>(
		null,
	);
	const pendingRecoveryFailureRef =
		useRef<PendingAttachmentRecoveryFailure | null>(null);
	const [attachmentGeneration, setAttachmentGeneration] = useState(0);
	const attachmentToken = `${attachmentKey}\u001f${attachmentGeneration}`;
	const replacementAttachmentToken = `${attachmentKey}\u001f${attachmentGeneration + 1}`;
	const attachmentContext = {
		attachmentKey,
		attachmentToken,
		replacementAttachmentToken,
	};
	const attachmentContextRef = useRef(attachmentContext);
	attachmentContextRef.current = attachmentContext;
	const presentedAttachmentTokenRef = useRef(attachmentToken);
	const eventCursorRef = useRef(createTerminalViewportEventCursor());
	const recoveryHighWaterRef = useRef<AttachmentRecoveryHighWater>({
		state: "armed",
	});
	const attachReconnectRef = useRef({ attachmentKey, failures: 0 });
	const attachedSessionRef = useRef<string | null>(null);
	const upstreamSequenceRef = useRef<UpstreamSequence | undefined>(undefined);
	const selectedCapabilitiesRef = useRef<ReadonlySet<string>>(new Set());
	const onAttachedRef = useRef(onAttached);
	const onEventRef = useRef(onEvent);
	const onSessionMetadataRef = useRef(onSessionMetadata);
	const onProviderConversationIdentityRef = useRef(
		onProviderConversationIdentity,
	);
	const onWorkingDirectoryRef = useRef(onWorkingDirectory);
	const callbacksRef = useRef({
		onInputReceipt,
		onViewportFrameReceived,
	});
	const onExitRef = useRef(onExit);
	const onAttachmentStartedRef = useRef(onAttachmentStarted);
	const onPaneConnectionStateRef = useRef(onPaneConnectionState);
	const onAttachmentRetiredRef = useRef(onAttachmentRetired);
	const onSurfaceRetirementRef = useRef(onSurfaceRetirement);
	const prepareAttachRef = useRef(prepareAttach);
	const onAttachPhaseRef = useRef(onAttachPhase);
	onAttachedRef.current = onAttached;
	onEventRef.current = onEvent;
	onSessionMetadataRef.current = onSessionMetadata;
	onProviderConversationIdentityRef.current = onProviderConversationIdentity;
	onWorkingDirectoryRef.current = onWorkingDirectory;
	callbacksRef.current = {
		onInputReceipt,
		onViewportFrameReceived,
	};
	onExitRef.current = onExit;
	onAttachmentStartedRef.current = onAttachmentStarted;
	onPaneConnectionStateRef.current = onPaneConnectionState;
	onAttachmentRetiredRef.current = onAttachmentRetired;
	onSurfaceRetirementRef.current = onSurfaceRetirement;
	prepareAttachRef.current = prepareAttach;
	onAttachPhaseRef.current = onAttachPhase;
	const isCurrentAttachment = useCallback(
		(
			attachment: StructuredTerminalAttachmentIdentity,
			requireAttached = false,
		) => {
			const context = attachmentContextRef.current;
			return (
				upstreamSequenceRef.current?.attachment === attachment &&
				observerIdRef.current === attachment.observerId &&
				context.attachmentKey === attachment.attachmentKey &&
				context.attachmentToken === attachment.attachmentToken &&
				context.replacementAttachmentToken ===
					attachment.replacementAttachmentToken &&
				(!requireAttached ||
					attachedObserverRef.current === attachment.observerId)
			);
		},
		[],
	);
	const {
		error,
		errorMessageId,
		dismissError,
		recoveryAvailable,
		connectionFailed,
		controller: failure,
	} = useStructuredTerminalFailurePresentation({
		isCurrentAttachment,
		pendingRecoveryFailureRef,
		upstreamSequenceRef,
	});
	const [presentationQueue] = useState(() =>
		createTerminalPresentationQueue<
			StructuredTerminalAttachmentIdentity,
			TerminalViewportFrameReplica<InstalledTerminalViewportFrame>
		>({
			readRole: () => presentationRoleRef.current,
			admit: admitTerminalPresentation,
			isCurrent: (attachment) => isCurrentAttachment(attachment, true),
			commit: (attachment, candidate) => {
				lastGoodPresentationRef.current = {
					attachmentKey: attachment.attachmentKey,
					attachmentToken: attachment.attachmentToken,
					replica: candidate,
				};
				presentedAttachmentTokenRef.current = attachment.attachmentToken;
				setReplica(candidate);
			},
		}),
	);
	const cancelPendingPresentation = presentationQueue.cancel;
	const commitPresentation = presentationQueue.commit;
	const schedulePresentation = presentationQueue.schedule;
	useEffect(() => {
		presentationQueue.refreshRole();
	}, [presentationQueue, presentationRole]);
	const recoverAttachment = useStructuredTerminalRecoverAttachment({
		isCurrentAttachment,
		cancelPendingPresentation,
		upstreamSequenceRef,
		recoveryHighWaterRef,
		setAttachmentGeneration,
	});
	const {
		handleAttachFailure,
		reportAttachmentFailure,
		reportRecoverableFailure,
		resolveFailureWithCompleteFrame,
	} = useStructuredTerminalAttachmentRecovery({
		attachmentKey,
		hostHealthy,
		connectionFailed: connectionFailed && attachedObserverRef.current === undefined,
		onAttachPhaseRef,
		isCurrentAttachment,
		recoverAttachment,
		// Mirrors the live stream's exit record delivery below — one receipt
		// shape, whichever side of the attach the exit fact arrived on. Only a
		// managed pane has an exited presentation to converge into, and only a
		// surface that consumes exit receipts can carry the fact.
		presentSessionExit: useCallback(
			(_attachment: StructuredTerminalAttachmentIdentity, reason: string) => {
				if (binding.runtime !== "hmux_managed_v1") return false;
				const onExit = onExitRef.current;
				if (!onExit) return false;
				onExit({ reason });
				return true;
			},
			[binding.runtime],
		),
		reportFailureForAttachment: failure.reportForAttachment,
		reportTerminalForAttachment: failure.reportTerminalForAttachment,
		resolveFailureForAttachment: failure.resolveWithCompleteFrame,
		lastGoodPresentationRef,
		pendingRecoveryFailureRef,
		onPaneConnectionStateRef,
		attachReconnectRef,
		setAttachmentGeneration,
	});
	const { sendInput, sendViewportIntent, requestViewportRows } =
		useStructuredTerminalOutboundIntents({
			isCurrentAttachment,
			observerIdRef,
			reportAttachmentFailure,
			reportFailureForAttachment: failure.reportForAttachment,
			reportRecoverableFailure,
			replicaRef,
			upstreamSequenceRef,
		});
	const supportsCapability = useCallback(
		(capability: string) => selectedCapabilitiesRef.current.has(capability),
		[],
	);

	useEffect(() => {
		const observerId = `structured-${crypto.randomUUID()}`;
		const runtimeObservation = useStore
			.getState()
			.beginSessionAgentRuntimeObservation(binding.sessionId);
		const reportAttachmentStarted = onAttachmentStartedRef.current;
		const reportSurfaceRetirement = onSurfaceRetirementRef.current;
		const reportAttachPhase = onAttachPhaseRef.current;
		reportAttachmentStarted?.(observerId);
		const attachmentAbortController = new AbortController();
		const attachment: StructuredTerminalAttachmentIdentity = {
			observerId,
			attachmentKey,
			attachmentToken,
			replacementAttachmentToken,
		};
		let attachmentLive = true;
		let initialPresentationBarrierMarked = false;
		let detachment: Promise<void> | undefined;
		let detachmentFailureReported = false;
		const reportDetachmentFailure = (cause: unknown) => {
			if (detachmentFailureReported) return;
			detachmentFailureReported = true;
			console.warn("[hmux] structured surface retirement failed", cause);
		};
		const markInitialPresentationBarrier = () => {
			if (initialPresentationBarrierMarked) return;
			initialPresentationBarrierMarked = true;
			reportAttachPhase?.({
				phase: "barrier",
				correlationId: observerId,
			});
		};
		const finalizeAttachment = (): Promise<void> => {
			runtimeObservation.dispose();
			if (attachmentLive) {
				attachmentLive = false;
				attachmentAbortController.abort();
				cancelPendingPresentation(attachment);
				onAttachmentRetiredRef.current?.(observerId);
				if (upstreamSequenceRef.current?.attachment === attachment) {
					observerIdRef.current = undefined;
					attachedObserverRef.current = undefined;
				}
			}
			if (!detachment) {
				try {
					detachment = Promise.resolve(
						hmux.detachStructuredTerminal(observerId),
					);
				} catch (cause) {
					detachment = Promise.reject(cause);
				}
			}
			return detachment;
		};
		let agentRuntimeFence: StructuredAgentRuntimeAttachmentFence | undefined;
		if (attachReconnectRef.current.attachmentKey !== attachmentKey) {
			attachReconnectRef.current = { attachmentKey, failures: 0 };
		}
		if (
			pendingRecoveryFailureRef.current !== null &&
			pendingRecoveryFailureRef.current.replacementAttachmentToken !==
				attachmentToken
		) {
			pendingRecoveryFailureRef.current = null;
		}
		const retainLastCompletePresentation =
			lastGoodPresentationRef.current !== null;
		const recovering =
			retainLastCompletePresentation || attachmentGeneration > 0;
		onPaneConnectionStateRef.current?.(
			recovering ? "recovering" : "connecting",
			recovering
				? "structured_terminal_reattach"
				: "structured_terminal_initial_attach",
		);
		cancelPendingPresentation();
		if (attachedSessionRef.current !== binding.sessionId) {
			attachedSessionRef.current = binding.sessionId;
			recoveryHighWaterRef.current = { state: "armed" };
			pendingRecoveryFailureRef.current = null;
			failure.clear();
		}
		const requireInitialViewportFrame = retainLastCompletePresentation;
		observerIdRef.current = observerId;
		attachedObserverRef.current = undefined;
		selectedCapabilitiesRef.current = new Set();
		upstreamSequenceRef.current = {
			observerId,
			attachment,
			nextRecordId: 1n,
			lastObservedInputOutputRecordId: 0n,
			resizePresentationPending: false,
			viewportDispatchTail: Promise.resolve(),
			receipts: createTerminalIntentReceiptSequence<PendingResizeReceipt>(),
			failed: false,
		};
		eventCursorRef.current = createTerminalViewportEventCursor();
		const freshReplica =
			createTerminalViewportFrameReplica<InstalledTerminalViewportFrame>(
				observerId,
			);
		replicaRef.current = freshReplica;
		if (!retainLastCompletePresentation) {
			presentedAttachmentTokenRef.current = attachmentToken;
			setReplica(freshReplica);
		}

		const consumeTerminalRecord = (
			decoded: DecodedTerminalStateRecord,
			present = true,
			deliveryTiming?: TerminalDeliveryTiming,
		): boolean => {
			const sequence = upstreamSequenceRef.current;
			if (
				sequence?.attachment !== attachment ||
				sequence.failed ||
				!isCurrentAttachment(attachment)
			) {
				return false;
			}
			const replicaApplyStartedAt =
				import.meta.env.MODE === "perf" && deliveryTiming ? performance.now() : 0;
			try {
				const reduction = reduceStructuredTerminalViewportRecord(
					replicaRef.current,
					observerId,
					decoded,
				);
				if (reduction.status === "event") {
					const eventReduction = reduceTerminalViewportEvent(
						eventCursorRef.current,
						reduction.terminalEpoch,
						reduction.event,
					);
					if (eventReduction.status === "duplicate") return true;
					if (eventReduction.status === "reattach_required") {
						throw new Error(
							eventReduction.reason ?? "structured terminal event diverged",
						);
					}
					onEventRef.current(eventReduction.event);
					eventCursorRef.current = eventReduction.cursor;
					return true;
				}
				if (reduction.status === "receipt") {
					if (reduction.terminalEpoch !== replicaRef.current.terminalEpoch) {
						throw new Error("terminal receipt epoch is not current");
					}
					const { kind, value } = reduction.receipt;
					const acknowledgement = acknowledgeTerminalIntentReceipt(
						sequence.receipts,
						kind,
						value.inReplyToRecordId,
					);
					if (acknowledgement.status === "unissued") {
						throw new Error(
							`terminal receipt does not match an issued ${kind} intent`,
						);
					}
					if (acknowledgement.status === "duplicate") return true;
					const pendingReceipt = acknowledgement.resizeToken;
					if (kind === "input") callbacksRef.current.onInputReceipt?.(value);
					if (
						recoveryHighWaterRef.current.state !== "waiting_for_seed" &&
						!sequence.failed
					) {
						recoveryHighWaterRef.current = { state: "armed" };
					}
					const receiptFailure = terminalIntentReceiptFailure(
						kind,
						value.outcome,
					);
					if (receiptFailure) {
						// A correlated receipt proves this attachment carried the
						// operation result. It is not authority to replace the surface.
						const handled =
							kind === "resize" &&
							pendingReceipt?.onFailure?.(receiptFailure, value.outcome) ===
								true;
						if (!handled)
							failure.failReceipt(
								attachment,
								kind,
								value.inReplyToRecordId,
								receiptFailure,
							);
						return true;
					}
					if (kind === "resize") {
						// A resize retires its refusal once the new geometry is painted.
						pendingReceipt?.onApplied?.(
							value.outcome,
							replicaRef.current.frame?.frame.projectionRevision ?? 0n,
							value.inReplyToRecordId,
						);
						sequence.resizePresentationPending = true;
					} else if (kind !== "input" || acknowledgement.userInput) {
						// An accepted receipt retires an older refusal of its kind. Focus
						// and pointer intents ride the input lane too; their receipts
						// prove nothing about the keystroke the user lost.
						failure.applyReceipt(attachment, kind, value.inReplyToRecordId);
					}
					return true;
				}
				if (reduction.status === "invalid") throw new Error(reduction.reason);
				if (reduction.status === "applied") {
					const firstCompleteFrame = replicaRef.current.frame === null;
					const immediateResizePresentation =
						present && sequence.resizePresentationPending;
					if (present) sequence.resizePresentationPending = false;
					const inputOutputTiming =
						reduction.replica.frame?.frame.inputOutputTiming;
					const newInputOutput =
						inputOutputTiming !== undefined &&
						inputOutputTiming.inputRecordId >
							sequence.lastObservedInputOutputRecordId &&
						inputOutputTiming.inputRecordId <=
							sequence.receipts.input.highestIssuedRecordId;
					const immediateInputOutput =
						presentationRoleRef.current !== "background" && newInputOutput;
					if (newInputOutput) {
						sequence.lastObservedInputOutputRecordId =
							inputOutputTiming.inputRecordId;
					}
					eventCursorRef.current = observeTerminalViewportEventHighWater(
						eventCursorRef.current,
						reduction.replica.terminalEpoch ?? "",
						reduction.replica.frame?.frame.throughEventId ?? 0n,
					);
					const previousViewportTitle = replicaRef.current.frame?.frame.title;
					replicaRef.current = reduction.replica;
					const viewportTitle = reduction.replica.frame?.frame.title;
					if (
						viewportTitle !== undefined &&
						viewportTitle !== previousViewportTitle
					) {
						useStore
							.getState()
							.setSessionTitle(binding.sessionId, viewportTitle);
					}
					if (import.meta.env.MODE === "perf" && deliveryTiming) {
						notifyViewportFrame(reduction.replica, callbacksRef.current, {
							...deliveryTiming,
							replicaApplyStartedAt,
							replicaAppliedAt: performance.now(),
						});
					} else {
						notifyViewportFrame(reduction.replica, callbacksRef.current);
					}
					const lastGoodPresentation = lastGoodPresentationRef.current;
					const synchronizedOutput =
						reduction.replica.frame?.frame.inputModes?.synchronizedOutput ===
						true;
					if (present && !synchronizedOutput) {
						markInitialPresentationBarrier();
					}
					if (!present || synchronizedOutput) {
						// DEC synchronized output is one presentation transaction. The
						// canonical replica keeps advancing for fences and receipts, while
						// the browser retains the last complete pixels until the mode ends.
						cancelPendingPresentation(attachment);
					} else if (firstCompleteFrame) {
						cancelPendingPresentation(attachment);
						commitPresentation(attachment, reduction.replica);
					} else if (immediateResizePresentation) {
						// The Host's resize receipt barrier orders this authoritative
						// geometry successor after its receipt. It must not inherit the
						// background catch-up delay while an older-sized bitmap is held.
						cancelPendingPresentation(attachment);
						commitPresentation(attachment, reduction.replica);
					} else if (immediateInputOutput) {
						// The Host already coalesced this attachment-local exact input
						// successor. Flush the same replica commit so React cannot retain an
						// older visual frame behind an unrelated automatic batch.
						cancelPendingPresentation(attachment);
						flushSync(() => commitPresentation(attachment, reduction.replica));
					} else if (
						!newInputOutput &&
						lastGoodPresentation?.attachmentKey === attachment.attachmentKey &&
						lastGoodPresentation.attachmentToken === attachment.attachmentToken &&
						lastGoodPresentation.replica.stateRevision ===
							reduction.replica.stateRevision &&
						lastGoodPresentation.replica.appliedIntentSeq ===
							reduction.replica.appliedIntentSeq
					) {
						cancelPendingPresentation(attachment);
					} else {
						schedulePresentation(
							attachment,
							reduction.replica,
						);
					}
					if (present && reduction.replica.frame !== null) {
						resolveFailureWithCompleteFrame(attachment);
					}
					if (!sequence.failed) {
						const recoveryHighWater = recoveryHighWaterRef.current;
						if (recoveryHighWater.state === "waiting_for_seed") {
							recoveryHighWaterRef.current = {
								state: "waiting_for_progress",
								projectionRevision: reduction.replica.projectionRevision,
							};
						} else if (
							recoveryHighWater.state === "waiting_for_progress" &&
							reduction.replica.projectionRevision >
								recoveryHighWater.projectionRevision
						) {
							recoveryHighWaterRef.current = { state: "armed" };
						}
					}
					return true;
				}
				if (reduction.status === "reattach_required") {
					throw new Error(
						reduction.reason ?? "structured terminal viewport diverged",
					);
				}
				return true;
			} catch (cause) {
				// A diverged or undecodable record is a connection fault: the
				// successor attach that follows can prove it is over.
				reportAttachmentFailure(attachment, cause, true);
				return false;
			}
		};

		const consumeCarrierRecord = (
			carrierRecord: StructuredTerminalCarrierRecord,
			present = true,
		): boolean => {
			if (!attachmentLive || !isCurrentAttachment(attachment)) return false;
			if (carrierRecord.kind === "failure") {
				reportAttachmentFailure(attachment, carrierRecord.reason, true);
				return false;
			}
			if (import.meta.env.MODE === "perf" && carrierRecord.kind === "terminal") {
				return consumeTerminalRecord(
					carrierRecord.decoded,
					present,
					carrierRecord.deliveryTiming,
				);
			}
			if (carrierRecord.kind === "terminal")
				return consumeTerminalRecord(
					carrierRecord.decoded,
					present,
				);
			const { record } = carrierRecord;
			const semantic = applySemanticProjectionRecord({
				record,
				fence: agentRuntimeFence,
				currentAttachmentToken: attachment.attachmentToken,
				reject: (reason) => {
					reportAttachmentFailure(attachment, reason, true);
					return false;
				},
				commits: {
					agentIdentity: (sessionId, identity) => {
						const state = useStore.getState();
						state.setSessionAgentPin(sessionId, null);
						state.setSessionAgent(sessionId, identity.agent);
					},
					agentRuntimeState: (_sessionId, state) =>
						runtimeObservation.publish(state),
					workingDirectory: (sessionId, workingDirectory) => {
						useStore.getState().setSessionCwd(sessionId, workingDirectory.path);
						onWorkingDirectoryRef.current?.(workingDirectory, binding);
					},
				},
			});
			if (semantic !== undefined) return semantic;
			if (record.kind === "provider_conversation_identity") {
				onProviderConversationIdentityRef.current?.(record.identity, binding);
			} else if (record.kind === "closed") {
				const sequence = upstreamSequenceRef.current;
				const pending =
					sequence?.attachment === attachment
						? terminalIntentReceiptPendingKinds(sequence.receipts)
						: null;
				// Posture is projected from the Host, never re-derived from the code.
				const close = terminalCarrierClose({
					code: record.code,
					message: record.message,
					retryDirective: record.retryDirective,
					pendingInput: pending?.input === true,
				});
				if (close.disposition === "recoverable") {
					reportRecoverableFailure(attachment, "carrier_closed", close.cause);
				} else {
					reportAttachmentFailure(attachment, close.cause);
				}
				return false;
			} else if (record.kind === "control" && record.body?.kind === "exit") {
				onExitRef.current?.(decodeHmuxSessionExitReceipt(record.body.payload));
				return false;
			} else if (record.kind === "control" && record.body?.kind === "error") {
				// Deliberately not retirable: a control error body carries only
				// `kind` and `message` (structuredTerminalRecordAdapter.ts:331).
				// A Host refusal that ends the stream arrives as a `closed`
				// record instead and does carry its posture; this branch is what
				// is left when one does not, so reporting it as permanent stays
				// the safe reading.
				reportAttachmentFailure(
					attachment,
					record.body.message ?? "structured terminal Host error",
				);
				return false;
			}
			return true;
		};
		const attach = () => {
			if (!attachmentLive || !isCurrentAttachment(attachment)) return;
			const attachStartedAt = performance.now();
			reportAttachPhase?.({
				phase: "invoke_started",
				correlationId: observerId,
			});
			return attachStructuredTerminalRecords({
				observerId,
				surfaceId,
				access: "writer",
				binding,
				sshHosts: useStore.getState().sshHosts,
				prepareAttach: prepareAttachRef.current,
				onNativeAttachStarted: recovering
					? () =>
							reportAttachPhase?.({
								phase: "recovery",
								correlationId: observerId,
								event: { state: "backend_attach" },
							})
					: undefined,
				onAttachReceipt: (receipt) =>
					reportAttachPhase?.({
						phase: "receipt",
						correlationId: observerId,
						backendCommandMs:
							receipt.backendCommandUs === undefined
								? undefined
								: receipt.backendCommandUs / 1_000,
						frontendInvokeMs: Math.max(0, performance.now() - attachStartedAt),
					}),
				requireInitialViewportFrame,
				signal: attachmentAbortController.signal,
				isCurrent: () => attachmentLive && isCurrentAttachment(attachment),
			});
		};
		const startAttach = () =>
			recovering && recoveryAdmission
				? recoveryAdmission.run({
						signal: attachmentAbortController.signal,
						readRole: () => presentationRoleRef.current,
						operation: attach,
						onState: (event) =>
							reportAttachPhase?.({
								phase: "recovery",
								correlationId: observerId,
								event,
							}),
					})
				: attach();
		let surfaceMounted = true;
		let attachmentSettled: Promise<void> = Promise.resolve();
		const retireSurface = () =>
			Promise.all([finalizeAttachment(), attachmentSettled]).then(() => undefined);
		const stopObservingClose = observeStructuredPaneClose({
			desktopId,
			paneApi,
			binding,
			retire: retireSurface,
			resume: () => {
				if (surfaceMounted) setAttachmentGeneration((value) => value + 1);
			},
		});
		attachmentSettled = Promise.resolve(startAttach())
			.then(async (attachedSurface) => {
				if (
					!attachedSurface ||
					!attachmentLive ||
					!isCurrentAttachment(attachment)
				) {
					return;
				}
				attachReconnectRef.current.failures = 0;
				const primed = primeStructuredTerminalViewport(
					observerId,
					attachedSurface,
				);
				selectedCapabilitiesRef.current = new Set(
					attachedSurface.selectedCapabilities,
				);
				replicaRef.current = primed;
				agentRuntimeFence = {
					sessionId: binding.sessionId,
					terminalEpoch: attachedSurface.terminalEpoch,
					attachmentToken: attachment.attachmentToken,
				};
				if (attachedSurface.session) {
					onSessionMetadataRef.current(attachedSurface.session);
				}
				attachedObserverRef.current = observerId;
				const initialDeliveryConsumed = consumeInitialCarrierRecords(
					attachedSurface.startDelivery(),
					(record) => consumeCarrierRecord(record, false),
				);
				if (!initialDeliveryConsumed) return;
				if (replicaRef.current.frame !== null) {
					resolveFailureWithCompleteFrame(attachment);
					lastGoodPresentationRef.current = {
						attachmentKey: attachment.attachmentKey,
						attachmentToken: attachment.attachmentToken,
						replica: replicaRef.current,
					};
					presentedAttachmentTokenRef.current = attachment.attachmentToken;
					markInitialPresentationBarrier();
					setReplica(replicaRef.current);
				} else if (!retainLastCompletePresentation) {
					presentedAttachmentTokenRef.current = attachmentToken;
					setReplica(replicaRef.current);
				}
				onAttachedRef.current(observerId);
				await runTerminalRecordDelivery({
					read: () => attachedSurface.readRecord(),
					consume: consumeCarrierRecord,
					readRole: () => presentationRoleRef.current,
					isCurrent: () => attachmentLive && isCurrentAttachment(attachment, true),
					signal: attachmentAbortController.signal,
				});
			})
			.catch((cause) =>
				handleAttachFailure({
					attachment,
					cause,
					signal: attachmentAbortController.signal,
					isLive: () => attachmentLive,
				}),
			)
			.finally(finalizeAttachment);
		void attachmentSettled.catch(reportDetachmentFailure);

		return () => {
			surfaceMounted = false;
			const retirement = retireSurface();
			// Hidden views can still own a pending native reservation. Keep their close
			// barrier subscribed until retirement settles, even after React unmounts.
			void retirement.then(stopObservingClose, stopObservingClose);
			if (reportSurfaceRetirement) {
				reportSurfaceRetirement(observerId, retirement);
			} else {
				void retirement.catch(reportDetachmentFailure);
			}
		};
	}, [
		desktopId,
		paneApi,
		attachmentKey,
		attachmentGeneration,
		attachmentToken,
		cancelPendingPresentation,
		commitPresentation,
		failure,
		handleAttachFailure,
		reportAttachmentFailure,
		reportRecoverableFailure,
		recoveryAdmission,
		resolveFailureWithCompleteFrame,
		schedulePresentation,
		surfaceId,
	]);

	return {
		replica,
		readLatestCompleteFrame,
		presentationIsCurrent:
			presentedAttachmentTokenRef.current === attachmentToken,
		error,
		errorMessageId,
		dismissError,
		recoveryAvailable,
		observerIdRef,
		attachedObserverRef,
		sendInput,
		sendViewportIntent,
		requestViewportRows,
		supportsCapability,
		resolveResizeFailure: failure.resolveCurrentResize,
		reportFailure: failure.report,
	};
}
