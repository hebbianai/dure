import type { IDockviewPanelProps } from "dockview-react";
import type { HmuxSessionExitReceipt } from "@/lib/terminal/structuredTerminalRecord";
import type { TerminalKillActionProps } from "@/components/terminal/TerminalViewChrome";
import type { RemoteHmuxManagedStartedMarkerV1 } from "@/lib/hmux/remote/remoteHmuxCommandBridge";
import type {
	HmuxProviderConversationIdentity,
	HmuxWorkingDirectory,
} from "@/lib/ipc";
import type { TerminalPresentationRole } from "@/lib/terminal/presentation/terminalPresentationRoleStore";
import type { TerminalAttachRecovery } from "@/lib/terminal/terminalAttachRecovery";
import type { HmuxPaneBindingV1 } from "@/lib/terminal/terminalBinding";
import type { TerminalWindowFocusProbe } from "@/lib/terminal/terminalWindowFocusProbe";
import type { Provider } from "@/types";

export interface StructuredTerminalViewProps extends TerminalKillActionProps {
	readonly sessionId: string;
	readonly providerHint?: Provider;
	readonly surfaceId?: string;
	/** Window-local Dockview pane key used only for connection-health projection. */
	readonly paneHealthId?: string;
	readonly binding: HmuxPaneBindingV1;
	readonly inputDisabled?: boolean;
	readonly paneApi?: IDockviewPanelProps["api"];
	readonly presentationRole?: TerminalPresentationRole;
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
	/** Reports whether the full-pane attach-recovery presentation is visible. */
	readonly onAttachRecoveryPresentationChange?: (visible: boolean) => void;
	/** Session recovery offered when the attachment fails. `intent` selects
	 * exact-resume or fresh-start presentation, and `context` is identity text
	 * prepended to the copyable error details. */
	readonly attachRecovery?: TerminalAttachRecovery;
}
