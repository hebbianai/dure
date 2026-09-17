import type { DockviewApi, IDockviewPanel } from "dockview-react";
import { createHmuxManagedShellTerminalOn } from "@/lib/sessions/managed/managedShellTerminal";
import type { TerminalEnvironment } from "@/types";

/** Replace only the captured content. Pane identity and placement survive;
 * a late shell result never closes or retargets newer user content. */
export async function replaceManagedAgentPaneWithShell({
	api,
	panelApi,
	cwd,
	terminalEnv,
	desktopId,
}: {
	api: DockviewApi;
	panelApi: IDockviewPanel["api"];
	cwd: string;
	terminalEnv?: TerminalEnvironment;
	desktopId?: string;
}) {
	return createHmuxManagedShellTerminalOn(
		api,
		cwd,
		{ replacement: panelApi },
		terminalEnv,
		desktopId,
	);
}
