import type { IDockviewPanelProps } from "dockview-react";
import type { MutableRefObject } from "react";
import type { HmuxSessionExitReceipt } from "@/lib/terminal/structuredTerminalRecord";
import type {
	InputReceipt,
	ResizeReceipt,
} from "@/contracts/terminalStateProtocol";
import type {
	HmuxProviderConversationIdentity,
	HmuxSessionSummary,
	HmuxWorkingDirectory,
} from "@/lib/ipc";
import type { TerminalPresentationRole } from "@/lib/terminal/presentation/terminalPresentationRoleStore";
import type { InstalledTerminalViewportFrame } from "@/lib/terminal/state/structuredTerminalViewport";
import type { TerminalFailureMessageId } from "@/lib/terminal/state/terminalFailurePresentation";
import type { TerminalInputFence } from "@/lib/terminal/state/terminalInputIntent";
import type {
	TerminalIntentReceiptKind,
	TerminalIntentReceiptSequence,
} from "@/lib/terminal/state/terminalIntentReceiptSequence";
import type { reduceTerminalViewportEvent } from "@/lib/terminal/state/terminalViewportEventCursor";
import type {
	TerminalViewportFrameReplica,
	TerminalViewportIntentFence,
} from "@/lib/terminal/state/terminalViewportFrameReplica";
import type { StructuredTerminalRecoveryAdmission } from "@/lib/terminal/structuredTerminalRecoveryAdmission";
import type { TerminalAttachTimingEvent } from "@/lib/terminal/terminalAttachPerformance";
import type { HmuxPaneBindingV1 } from "@/lib/terminal/terminalBinding";
import type { TerminalReplicaTiming } from "@/lib/terminal/terminalDeliveryTimingFacts";
import type { HmuxPaneHealthState } from "@/lib/terminal/terminalHealth";

export interface ViewportIntentInputFence {
	readonly schemaMinor: number;
	readonly terminalEpoch: string;
	readonly throughOutputSeq: bigint;
	readonly stateRevision: bigint;
}

export interface StructuredTerminalAttachmentIdentity {
	readonly observerId: string;
	readonly attachmentKey: string;
	readonly attachmentToken: string;
	readonly replacementAttachmentToken: string;
}

export interface StructuredTerminalViewportFrameReceipt {
	readonly deliveryTiming?: TerminalReplicaTiming;
	readonly attachmentId: string;
	readonly terminalEpoch: string;
	readonly throughOutputSeq: bigint;
	readonly inputOutputTiming: {
		readonly inputBaselineOutputSequence: bigint;
		readonly firstOutputSequence: bigint;
		readonly inputToOutputMicros: bigint;
		readonly outputToProjectionStartMicros: bigint;
		readonly inputRecordId: bigint;
	} | null;
}

export type AttachmentRecoveryHighWater =
	| { readonly state: "armed" }
	| { readonly state: "waiting_for_seed" }
	| {
			readonly state: "waiting_for_progress";
			readonly projectionRevision: bigint;
	  };

export interface LastGoodTerminalPresentation {
	readonly attachmentKey: string;
	readonly attachmentToken: string;
	readonly replica: TerminalViewportFrameReplica<InstalledTerminalViewportFrame>;
}

export interface PendingResizeReceipt {
	readonly onApplied?: (
		outcome: ResizeReceipt["outcome"],
		afterProjectionRevision: bigint,
		recordId: bigint,
	) => void;
	readonly onFailure?: (
		failure: Error,
		outcome: ResizeReceipt["outcome"],
	) => boolean | undefined;
}

export interface UpstreamSequence {
	readonly observerId: string;
	readonly attachment: StructuredTerminalAttachmentIdentity;
	nextRecordId: bigint;
	/** Newest attachment-local Host timing already classified for presentation. */
	lastObservedInputOutputRecordId: bigint;
	/** A successful resize receipt whose receipt-barrier successor must reveal now. */
	resizePresentationPending: boolean;
	/** Host viewport intent_seq is strict; only that stream waits for native admission. */
	viewportDispatchTail: Promise<void>;
	readonly receipts: TerminalIntentReceiptSequence<PendingResizeReceipt>;
	failed: boolean;
}

export interface TerminalResizeReceiptCallbacks {
	readonly onApplied?: PendingResizeReceipt["onApplied"];
	readonly onFailure?: PendingResizeReceipt["onFailure"];
}

export type RecoverableAttachmentFailureOrigin =
	| "attach"
	| "carrier_closed"
	| "transport_send_resize"
	| "transport_send_viewport";

export interface PendingAttachmentRecoveryFailure {
	readonly origin: RecoverableAttachmentFailureOrigin;
	readonly message: string;
	readonly failedObserverId: string;
	readonly failedAttachmentKey: string;
	readonly failedAttachmentToken: string;
	readonly replacementAttachmentToken: string;
}

export type AttachmentRecoveryDisposition = {
	readonly status: "started" | "duplicate" | "bounded" | "stale";
};

export interface StructuredTerminalViewportTransport {
	readonly replica: TerminalViewportFrameReplica<InstalledTerminalViewportFrame>;
	readonly readLatestCompleteFrame: () => InstalledTerminalViewportFrame | null;
	readonly presentationIsCurrent: boolean;
	readonly error: string | undefined;
	readonly errorMessageId: TerminalFailureMessageId | undefined;
	readonly dismissError: (() => void) | undefined;
	readonly recoveryAvailable: boolean;
	readonly observerIdRef: MutableRefObject<string | undefined>;
	readonly attachedObserverRef: MutableRefObject<string | undefined>;
	readonly sendInput: (
		encode: (recordId: bigint, fence: TerminalInputFence) => Uint8Array,
		receiptKind?: TerminalIntentReceiptKind,
		receiptCallbacks?: TerminalResizeReceiptCallbacks,
		onTransportConfirmed?: () => void,
		origin?: "user" | "surface",
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
	readonly supportsCapability: (capability: string) => boolean;
	readonly resolveResizeFailure: (recordId: bigint) => void;
	readonly reportFailure: (cause: unknown) => void;
}

export interface UseStructuredTerminalViewportTransportOptions {
	readonly paneApi?: IDockviewPanelProps["api"];
	readonly surfaceId: string;
	readonly binding: HmuxPaneBindingV1;
	readonly presentationRole: TerminalPresentationRole;
	readonly recoveryAdmission?: StructuredTerminalRecoveryAdmission;
	readonly prepareAttach?: () => Promise<unknown>;
	readonly onAttachPhase?: (event: TerminalAttachTimingEvent) => void;
	readonly onAttached: (attachmentId: string) => void;
	readonly onEvent: (
		event: Parameters<typeof reduceTerminalViewportEvent>[2],
	) => void;
	readonly onSessionMetadata: (session: HmuxSessionSummary) => void;
	readonly onProviderConversationIdentity?: (
		identity: HmuxProviderConversationIdentity,
		attachedBinding: HmuxPaneBindingV1,
	) => void;
	readonly onWorkingDirectory?: (
		workingDirectory: HmuxWorkingDirectory,
		attachedBinding: HmuxPaneBindingV1,
	) => void;
	readonly onInputReceipt?: (receipt: InputReceipt) => void;
	readonly onViewportFrameReceived?: (
		receipt: StructuredTerminalViewportFrameReceipt,
	) => void;
	readonly onPaneConnectionState?: (
		state: Extract<HmuxPaneHealthState, "connecting" | "recovering" | "error">,
		reason?: string,
	) => void;
	readonly onExit?: (receipt: HmuxSessionExitReceipt) => void;
	readonly onAttachmentStarted?: (attachmentId: string) => void;
	readonly onAttachmentRetired?: (attachmentId: string) => void;
	readonly onSurfaceRetirement?: (
		attachmentId: string,
		retirement: Promise<void>,
	) => void;
}
