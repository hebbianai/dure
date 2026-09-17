/** Owns the pane header's standalone ↔ managed conversion: which way this
 * pane can convert, whether one is running, and the confirm and failure
 * dialogs around the shared workflow. The header renders the action.
 * Mirrors usePaneRehostAction. */

import { ask, message as messageDialog } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import type { HmuxManagedPromotionAvailability } from "@/lib/hmux/conversion/hmuxManagedPromotionEligibility";
import type { HmuxSessionConversionTarget } from "@/lib/hmux/conversion/hmuxSessionConversion";
import { runHmuxSessionConversionWorkflow } from "@/lib/hmux/conversion/hmuxSessionConversionWorkflow";
import { t } from "@/lib/i18n";
import type { TerminalPaneBindingV1 } from "@/lib/terminal/terminalBinding";

export interface PaneSessionConversion {
	/** The runtime this pane would convert to, or undefined when it cannot. */
	readonly target: HmuxSessionConversionTarget | undefined;
	readonly busy: boolean;
	readonly convert: () => Promise<void>;
}

export function usePaneSessionConversion({
	binding,
	sessionName,
	panelId,
	managedPromotion,
}: {
	binding: TerminalPaneBindingV1 | undefined;
	sessionName: string | undefined;
	panelId: string;
	managedPromotion: HmuxManagedPromotionAvailability;
}): PaneSessionConversion {
	const [busy, setBusy] = useState(false);
	const target: HmuxSessionConversionTarget | undefined =
		binding?.runtime === "hmux_standalone_v1"
			? "managed"
			: binding?.runtime === "hmux_managed_v1"
				? "standalone"
				: undefined;
	const convert = async () => {
		if (!binding || !target || busy) return;
		// Promotion has its own eligibility (idle, known location, local);
		// demotion does not.
		if (target === "managed" && managedPromotion !== "eligible") return;
		setBusy(true);
		try {
			await runHmuxSessionConversionWorkflow(
				{
					sourceSessionId: binding.sessionId,
					sourceWorkspaceId: binding.workspaceId,
					sourceSessionName: sessionName,
					panelId,
					target,
				},
				({ title, message }) => ask(message, { title, kind: "warning" }),
			);
		} catch (error) {
			await messageDialog(
				t("common.hmuxSwitch.failed", { error: String(error) }),
				{ title: t("common.hmuxSwitch.title"), kind: "error" },
			);
		} finally {
			setBusy(false);
		}
	};
	return { target, busy, convert };
}
