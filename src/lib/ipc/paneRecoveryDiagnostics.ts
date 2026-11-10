import { invoke } from "@tauri-apps/api/core";

import type {
	PaneRecoveryDiagnosticInput,
	PaneRecoveryDiagnostics,
} from "../../../cli/lib/contracts/pane-recovery-diagnostics.mjs";

export type {
	PaneRecoveryDiagnosticInput,
	PaneRecoveryDiagnostics,
} from "../../../cli/lib/contracts/pane-recovery-diagnostics.mjs";

export const appendPaneRecoveryDiagnostic = (
	event: PaneRecoveryDiagnosticInput,
) => invoke<void>("append_pane_recovery_diagnostic", { event });

export const readPaneRecoveryDiagnostics =
	(): Promise<PaneRecoveryDiagnostics> =>
		invoke<PaneRecoveryDiagnostics>("read_pane_recovery_diagnostics").catch(
			() => ({
				schemaVersion: 1,
				state: "unavailable",
				events: [],
			}),
		);
