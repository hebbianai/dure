import type {
	HmuxAgentIdentity,
	HmuxAgentRuntimeState,
	HmuxProviderConversationIdentity,
	HmuxWorkingDirectory,
} from "@/lib/ipc";
import type { HmuxStructuredTerminalRetryDirective } from "@/lib/hmux/failure/structuredTerminalAttachFailure";
import type { DecodedTerminalStateRecord } from "@/lib/terminal/protocol/terminalStateProtocol";
import type { TerminalDeliveryTiming } from "./terminalDeliveryTimingFacts";

interface StructuredTerminalControlPayload {
	readonly exit_code?: number | null;
	readonly platform_status?: string | null;
	readonly reason?: string;
}

export type StructuredTerminalAdapterRecord =
	| {
			readonly kind: "agent_identity";
			readonly identity: HmuxAgentIdentity;
	  }
	| {
			readonly kind: "agent_runtime_state";
			readonly state: HmuxAgentRuntimeState;
	  }
	| {
			readonly kind: "provider_conversation_identity";
			readonly identity: HmuxProviderConversationIdentity;
	  }
	| {
			readonly kind: "working_directory";
			readonly workingDirectory: HmuxWorkingDirectory;
	  }
	| {
			readonly kind: "closed";
			readonly code?: string;
			readonly message?: string;
			/** Retry posture owned by the client boundary, never re-derived here. */
			readonly retryDirective: HmuxStructuredTerminalRetryDirective;
	  }
	| {
			readonly kind: "control";
			readonly body?: {
				readonly kind?: string;
				readonly message?: string;
				/** FrameBody payload — snake_case wire fields from the Host. */
				readonly payload?: StructuredTerminalControlPayload;
			};
	  };

/** Session end as the Host reported it — the structured counterpart of the
 * legacy `session:exit` event. `exitCode` is absent when the platform did not
 * report one (signal death, lost child). */
export interface HmuxSessionExitReceipt {
	readonly exitCode?: number;
	readonly reason?: string;
}

export function decodeHmuxSessionExitReceipt(
	payload?: StructuredTerminalControlPayload,
): HmuxSessionExitReceipt {
	return {
		exitCode: typeof payload?.exit_code === "number" ? payload.exit_code : undefined,
		reason: typeof payload?.reason === "string" ? payload.reason : undefined,
	};
}

export type StructuredTerminalCarrierRecord =
	| {
			readonly kind: "terminal";
			readonly decoded: DecodedTerminalStateRecord;
			readonly encodedByteLength: number;
			readonly deliveryTiming?: TerminalDeliveryTiming;
	  }
	| {
			readonly kind: "adapter";
			readonly record: StructuredTerminalAdapterRecord;
			readonly encodedByteLength: number;
	  }
	| {
			readonly kind: "failure";
			readonly reason: string;
			readonly encodedByteLength: 0;
	  };
