import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Expand } from "lucide-react";
import { useCallback, useLayoutEffect, useSyncExternalStore } from "react";
import { RetiredLegacyPane } from "@/components/terminal/RetiredLegacyPane";
import { Titled } from "@/components/ui/tooltip";
import type { TerminalViewProps } from "@/components/terminal/TerminalViewProps";
import { VisibilityRetainedStructuredTerminal } from "@/components/terminal/VisibilityRetainedStructuredTerminal";
import {
	useWorkspaceRuntimeDesktopId,
	useWorkspaceTerminalPresentationRetained,
	useWorkspaceTerminalPresentationRole,
} from "@/components/workspace/WorkspaceRuntimeContext";
import { hmuxPaneOwnerId } from "@/lib/hmux/hmuxPaneRetirement";
import { t } from "@/lib/i18n";
import { clearHmuxPaneHealth } from "@/lib/terminal/hmuxPaneHealthStore";
import { structuredTerminalAttachmentKey } from "@/lib/terminal/structuredTerminalRecordAdapter";
import {
	type HmuxPaneBindingV1,
	isHmuxPaneBinding,
} from "@/lib/terminal/terminalBinding";
import { hmuxPaneHealthId } from "@/lib/terminal/terminalHealth";
import {
	agentSessionSourceIsOpen,
	subscribeAgentSessionSourcePresence,
} from "@/lib/workspace/window/agentSessionWindowSource";
import { openAgentSessionWindow } from "@/lib/workspace/window/windows";
export type { TerminalQaBufferState } from "@/lib/terminal/terminalViewContracts";

// The legacy xterm renderer is retired (2026-08-16): every runtime producer
// of legacy bindings is gone, so a non-hmux binding can only come from a
// persisted pane that predates the migration — it gets a dead-end notice.

const detachedVisible = () => true;

function VisibleTerminalPresentation({
	paneHealthId,
	...props
}: TerminalViewProps & { readonly paneHealthId?: string }) {
	// A warm desktop keeps this presentation attached while hidden so a switch
	// reveals painted rows instead of a fresh Hmux attach (#736). Only the
	// frozen tier and a hidden Dockview tab release it.
	const presentationRetained = useWorkspaceTerminalPresentationRetained();
	const desktopId = useWorkspaceRuntimeDesktopId();
	const presentationRole = useWorkspaceTerminalPresentationRole(
		props.paneApi?.id,
	);
	const subscribePaneVisibility = useCallback(
		(listener: () => void) => {
			if (!props.paneApi) return () => {};
			const subscription = props.paneApi.onDidVisibilityChange(listener);
			return () => subscription.dispose();
		},
		[props.paneApi],
	);
	const readPaneVisibility = useCallback(
		() => props.paneApi?.isVisible ?? true,
		[props.paneApi],
	);
	const paneVisible = useSyncExternalStore(
		subscribePaneVisibility,
		readPaneVisibility,
		detachedVisible,
	);

	if (!presentationRetained || !paneVisible) return null;
	if (isHmuxPaneBinding(props.binding)) {
		const binding: HmuxPaneBindingV1 = props.binding;
		const surfaceId =
			props.surfaceId ??
			(desktopId && props.paneApi
				? hmuxPaneOwnerId(
						getCurrentWebviewWindow().label,
						desktopId,
						props.paneApi.id,
					)
				: props.paneApi?.id);
		return (
			<VisibilityRetainedStructuredTerminal
				{...props}
				binding={binding}
				surfaceId={surfaceId}
				paneHealthId={paneHealthId}
				presentationRole={presentationRole}
			/>
		);
	}

	return (
		<RetiredLegacyPane
			onClose={props.paneApi ? () => props.paneApi?.close() : undefined}
		/>
	);
}

export function TerminalView(props: TerminalViewProps) {
	const desktopId = useWorkspaceRuntimeDesktopId();
	const binding = isHmuxPaneBinding(props.binding) ? props.binding : undefined;
	const paneHealthId =
		props.paneApi && binding
			? hmuxPaneHealthId(desktopId, props.paneApi.id)
			: undefined;
	const attachmentKey = binding
		? structuredTerminalAttachmentKey(binding)
		: undefined;
	const largeViewAgentId = props.largeView?.agentId;
	const largeViewSourceWindowLabel = props.largeView?.sourceWindowLabel;
	const sourcePaneOwnerId =
		largeViewAgentId && desktopId && props.paneApi
			? `${desktopId}:${props.paneApi.id}`
			: undefined;
	const subscribePresence = useCallback(
		(listener: () => void) =>
			largeViewAgentId
				? subscribeAgentSessionSourcePresence(largeViewAgentId, listener)
				: () => {},
		[largeViewAgentId],
	);
	const readPresence = useCallback(
		() =>
			Boolean(
				largeViewAgentId &&
					sourcePaneOwnerId &&
					largeViewSourceWindowLabel &&
					agentSessionSourceIsOpen(largeViewAgentId, {
						windowLabel: largeViewSourceWindowLabel,
						paneOwnerId: sourcePaneOwnerId,
					}),
			),
		[largeViewAgentId, largeViewSourceWindowLabel, sourcePaneOwnerId],
	);
	const largeViewActive = useSyncExternalStore(
		subscribePresence,
		readPresence,
		() => false,
	);
	// Ordinary hiding retains this binding's last exact frame. Replacing the
	// binding or handing presentation to another window retires its observation
	// before a replacement renderer can publish a frame in the layout phase.
	useLayoutEffect(() => {
		if (!paneHealthId) return;
		return () => clearHmuxPaneHealth(paneHealthId);
	}, [paneHealthId, attachmentKey, largeViewActive]);
	if (largeViewActive && largeViewAgentId && sourcePaneOwnerId) {
		const label = t("terminal.largeView.bringToFront");
		return (
			<Titled title={label}>
				<button
					type="button"
					className="flex h-full w-full cursor-pointer items-center justify-center text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:inset-ring-1 focus-visible:inset-ring-ring"
					data-agent-session-window-proxy=""
					aria-label={label}
					onClick={() =>
						void openAgentSessionWindow(
							largeViewAgentId,
							undefined,
							sourcePaneOwnerId,
						)
					}
				>
					<span className="flex items-center gap-2 text-xs">
						<Expand className="size-3.5" />
						{t("terminal.largeView.openNotice")}
					</span>
				</button>
			</Titled>
		);
	}
	return <VisibleTerminalPresentation {...props} paneHealthId={paneHealthId} />;
}
