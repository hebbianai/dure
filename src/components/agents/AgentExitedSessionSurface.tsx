import { useCallback, useEffect, useState } from "react";
import { ManagedAgentRecoveryBar } from "@/components/sessions/ManagedAgentRecoveryBar";
import { StructuredTerminalRecoveryStatus } from "@/components/terminal/structured/StructuredTerminalRecoveryStatus";
import {
	sameHmuxManagedLaunchBinding,
	type HmuxManagedPaneBindingV1,
	type TerminalPaneBindingV1,
} from "@/lib/terminal/terminalBinding";
import type { TerminalAttachRecovery } from "@/lib/terminal/terminalAttachRecovery";
import { subscribeManagedRecovery } from "@/lib/workspace/pane/paneMenuSignals";
import type { AgentActivity } from "@/types";

export function AgentExitedSessionSurface({
	agentId,
	panelId,
	binding,
	activity,
	authoritativeExit,
	attachRecovery,
	onOpenShell,
	resuming,
	structuredAttachRecoveryVisible,
	onTransitioningChange,
	onRecoveryAvailabilityChange,
}: {
	agentId: string;
	panelId: string;
	binding?: TerminalPaneBindingV1;
	activity: AgentActivity;
	authoritativeExit: boolean;
	attachRecovery?: TerminalAttachRecovery;
	onOpenShell?: () => Promise<void>;
	resuming: boolean;
	structuredAttachRecoveryVisible: boolean;
	onTransitioningChange?(transitioning: boolean): void;
	onRecoveryAvailabilityChange?(available: boolean, deadInput: boolean): void;
}) {
	const managedBinding =
		binding?.runtime === "hmux_managed_v1" && binding.source === "local"
			? binding
			: undefined;
	const [recoveryRequestedFor, setRecoveryRequestedFor] =
		useState<HmuxManagedPaneBindingV1>();
	const recoveryRequested = Boolean(
		managedBinding &&
			recoveryRequestedFor &&
			sameHmuxManagedLaunchBinding(managedBinding, recoveryRequestedFor),
	);
	const handleRecoveryAvailability = useCallback(
		(available: boolean, deadInput: boolean) => {
			if (!available) setRecoveryRequestedFor(undefined);
			onRecoveryAvailabilityChange?.(available, deadInput);
		},
		[onRecoveryAvailabilityChange],
	);
	useEffect(
		() =>
			subscribeManagedRecovery(panelId, () =>
				setRecoveryRequestedFor(
					managedBinding
						? {
								...managedBinding,
								...(managedBinding.stopFence
									? { stopFence: { ...managedBinding.stopFence } }
									: {}),
							}
						: undefined,
				),
			),
		[managedBinding, panelId],
	);

	return (
		<div hidden={resuming}>
			{!structuredAttachRecoveryVisible && (
				<ManagedAgentRecoveryBar
					agentId={agentId}
					panelId={panelId}
					binding={managedBinding}
					inspectConfirmedExit={false}
					inspectUnknownExit={!authoritativeExit}
					forceConversationSelection={recoveryRequested}
					disabled={resuming}
					onOpenShell={onOpenShell}
					onTransitioningChange={onTransitioningChange}
					onAvailabilityChange={handleRecoveryAvailability}
					fallback={
						activity === "exited" && attachRecovery ? (
							<StructuredTerminalRecoveryStatus
								paneId={panelId}
								error="session_exited"
								attachRecovery={attachRecovery}
								// The chat pane paints the group's surface, not the terminal's.
								surface="pane"
							/>
						) : null
					}
				/>
			)}
		</div>
	);
}
