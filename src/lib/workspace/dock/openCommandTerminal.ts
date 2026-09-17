import type { DockviewApi } from "dockview-react";
import { t } from "@/lib/i18n";
import { showErrorToast } from "@/lib/toast";
import { withDesktopDockview } from "@/lib/workspace/dock";
import { createHmuxStandaloneTerminalOn } from "@/lib/workspace/dock/standaloneShellTerminal";

export interface OpenCommandTerminalOptions {
	title: string;
	command: string;
	cwd?: string;
	closeOnSuccess?: boolean;
}

/**
 * Open a one-shot command (login, setup, usage CLI) as its own pane.
 *
 * The command runs as a standalone hmux session through the user's login
 * shell — it survives reloads, shows on the phone, and its Host exit receipt
 * drives `closeOnSuccess` (exit 0 closes the pane; any failure leaves the
 * output inspectable). Creation failures surface as a toast rather than a
 * silently missing pane.
 */
export function openCommandTerminalOn(
	api: DockviewApi,
	options: OpenCommandTerminalOptions,
): void {
	void createHmuxStandaloneTerminalOn(api, options.cwd, undefined, undefined, undefined, {
		commandLine: options.command,
		title: options.title,
		closeOnSuccess: options.closeOnSuccess,
	}).catch((error: unknown) => {
		const detail = error instanceof Error ? error.message : String(error);
		showErrorToast(
			t("terminal.commandPane.openFailed", { detail }),
		);
	});
}

/** Same one-shot command pane for a caller that holds a desktop id rather than
 * a live Dockview — a sidebar surface, for instance. Activates that desktop
 * and opens the pane there, so the command runs where the user is looking. */
export function openCommandTerminalPanel(
	desktopId: string,
	options: OpenCommandTerminalOptions,
): void {
	withDesktopDockview(desktopId, (api) => {
		openCommandTerminalOn(api, options);
	});
}
