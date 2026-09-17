import type { IDockviewPanelProps } from "dockview-react";
import type { HmuxSessionExitReceipt } from "@/lib/terminal/structuredTerminalRecord";
import type { TerminalKillActionProps } from "@/components/terminal/TerminalViewChrome";
import type { RemoteHmuxManagedStartedMarkerV1 } from "@/lib/hmux/remote/remoteHmuxCommandBridge";
import type {
	HmuxProviderConversationIdentity,
	HmuxWorkingDirectory,
} from "@/lib/ipc";
import type { TerminalAttachRecovery } from "@/lib/terminal/terminalAttachRecovery";
import type {
	HmuxPaneBindingV1,
	TerminalPaneBindingV1,
} from "@/lib/terminal/terminalBinding";
import type { TerminalWindowFocusProbe } from "@/lib/terminal/terminalWindowFocusProbe";
import type { Provider, SessionKind } from "@/types";

/** Public pane contract. TerminalView routes the binding to one renderer. */
export interface TerminalViewProps extends TerminalKillActionProps {
	readonly sessionId: string;
	/** Agent-owned presentation fact used while session projections converge. */
	readonly providerHint?: Provider;
	/** Stable window-local renderer slot; Dockview panes use paneApi.id. */
	readonly surfaceId?: string;
	/** Agent window routing for a Dockview-owned source pane. */
	readonly largeView?: {
		readonly agentId: string;
		readonly sourceWindowLabel: string;
	};
	readonly kind: SessionKind;
	readonly binding?: TerminalPaneBindingV1;
	readonly runtimeWorkingDirectory?: string;
	readonly epoch?: number;
	readonly recoverDetachedAttach?: boolean;
	/** Presentation-level user-input gate; output and scrollback stay readable. */
	readonly inputDisabled?: boolean;
	readonly paneApi?: IDockviewPanelProps["api"];
	readonly ensure?: (columns: number, rows: number) => Promise<unknown>;
	readonly onSplit?: (direction: "right" | "below") => void;
	readonly onRemoteManagedStarted?: (
		marker: RemoteHmuxManagedStartedMarkerV1,
	) => void;
	readonly onProviderConversationIdentity?: (
		identity: HmuxProviderConversationIdentity,
		attachedBinding: HmuxPaneBindingV1,
	) => void;
	readonly onWorkingDirectory?: (
		workingDirectory: HmuxWorkingDirectory,
		attachedBinding: HmuxPaneBindingV1,
	) => void;
	readonly onHmuxSessionExit?: (receipt: HmuxSessionExitReceipt) => void;
	readonly windowFocusProbe?: TerminalWindowFocusProbe;
	readonly onFirstPaint?: () => void;
	readonly onGeometryObserved?: () => void;
	readonly onStructuredSurfaceRetirement?: (retirement: Promise<void>) => void;
	/** Reports the structured terminal's actual attach-recovery presentation.
	 * Agent panes use this fact to suppress their lower-priority recovery UI. */
	readonly onAttachRecoveryPresentationChange?: (visible: boolean) => void;
	/** Explicit replacement recovery offered when the source is gone; see
	 * `StructuredTerminalViewProps.attachRecovery`. */
	readonly attachRecovery?: TerminalAttachRecovery;
}
