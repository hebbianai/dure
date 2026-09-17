import type { IDockviewPanelProps } from "dockview-react";
import { RetiredLegacyPane } from "@/components/terminal/RetiredLegacyPane";

/** `ssh:` panels carried the legacy remote PTY runtime. Nothing creates them
 * any more (SSH shells open as remote hmux sessions since 2026-08-16), so a
 * mounted one can only be a persisted pre-migration pane — show the shared
 * dead-end notice instead of respawning a connection nobody owns. */
export function SshPanel(
	props: IDockviewPanelProps<{
		sessionId: string;
		hostId: string;
		cwd?: string;
		command?: string;
	}>,
) {
	return <RetiredLegacyPane onClose={() => props.api.close()} />;
}
