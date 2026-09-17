import type { DockviewApi, IDockviewPanel } from "dockview-react";
import {
	type KeyboardEvent as ReactKeyboardEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { replaceManagedAgentPaneWithShell } from "@/lib/sessions/managed/managedAgentPaneToShell";
import type { TerminalPaneBindingV1 } from "@/lib/terminal/terminalBinding";
import { useStore } from "@/store";
import type { AgentActivity, TerminalEnvironment } from "@/types";

function isTerminalInterruptKey(event: ReactKeyboardEvent<HTMLDivElement>) {
	return (
		event.ctrlKey &&
		!event.altKey &&
		!event.metaKey &&
		event.key.toLowerCase() === "c"
	);
}

export function useManagedAgentTerminalFallback({
	agentId,
	activity,
	binding,
	containerApi,
	panelApi,
	cwd,
	terminalEnv,
	desktopId,
	recoveryAvailable = false,
	disabled = false,
	onTransitioningChange,
	onError,
}: {
	agentId?: string;
	activity: AgentActivity;
	binding?: TerminalPaneBindingV1;
	containerApi: DockviewApi;
	panelApi: IDockviewPanel["api"];
	cwd?: string;
	terminalEnv?: TerminalEnvironment;
	desktopId?: string;
	recoveryAvailable?: boolean;
	disabled?: boolean;
	onTransitioningChange?(transitioning: boolean): void;
	onError(error: unknown): void;
}) {
	const [openingShell, setOpeningShell] = useState(false);
	const [authoritativeExit, setAuthoritativeExit] = useState(false);
	const replacementInFlightRef = useRef(false);
	const canOpenShell =
		binding?.runtime === "hmux_managed_v1" && binding.source === "local";
	useEffect(() => {
		if (activity !== "exited") setAuthoritativeExit(false);
	}, [activity]);
	const openShell = useCallback(async () => {
		if (disabled || !canOpenShell || !cwd || replacementInFlightRef.current) return;
		replacementInFlightRef.current = true;
		setOpeningShell(true);
		onTransitioningChange?.(true);
		try {
			await replaceManagedAgentPaneWithShell({
				api: containerApi,
				panelApi,
				cwd,
				terminalEnv,
				desktopId,
			});
		} finally {
			onTransitioningChange?.(false);
			replacementInFlightRef.current = false;
			setOpeningShell(false);
		}
	}, [
		canOpenShell,
		containerApi,
		cwd,
		desktopId,
		disabled,
		onTransitioningChange,
		panelApi,
		terminalEnv,
	]);

	const onTerminalKeyDown = useCallback(
		(event: ReactKeyboardEvent<HTMLDivElement>) => {
			if (
				disabled ||
				!recoveryAvailable ||
				!canOpenShell ||
				!isTerminalInterruptKey(event)
			) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			void openShell().catch(onError);
		},
		[canOpenShell, disabled, onError, openShell, recoveryAvailable],
	);

	const onHmuxSessionExit = useCallback(() => {
		setAuthoritativeExit(true);
		if (agentId) useStore.getState().setAgentActivity(agentId, "exited");
	}, [agentId]);

	return {
		authoritativeExit,
		openingShell,
		onHmuxSessionExit,
		onOpenShell: canOpenShell ? openShell : undefined,
		onTerminalKeyDown,
	};
}
