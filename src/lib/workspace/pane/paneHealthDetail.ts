import { hmuxSessionDiagnosticDetail } from "@/lib/hmux/identity/hmuxSessionMetadata";
import { t } from "@/lib/i18n";
import type { HmuxSessionSummary } from "@/lib/ipc";
import type { HmuxPaneHealthState } from "@/lib/terminal/terminalHealth";

/** The label a pane gives its Hmux session: its name, else its id. */
export function hmuxPaneSessionLabel(
	sessionName: string | undefined,
	sessionId: string | undefined,
): string {
	return sessionName || (sessionId ? `Hmux ${sessionId}` : "Hmux");
}

/** The receipts the pane's health observation carries beside its state. */
export interface PaneHealthReceipts {
	readonly reason?: string;
	readonly terminalEpoch?: string | number;
	readonly receivedSequence?: string | number;
	readonly presentedSequence?: string | number;
}

/** The health chip's hover title. The chip itself says only that something
 *  is wrong; the session's name, class, host build, retirement policy and the
 *  whole health diagnostic — state, control-plane detail, reason, epoch and
 *  sequence receipts — stay here (Pinpoint report 2026-07-31). */
export function paneHealthChipTitle(input: {
	sessionLabel: string;
	metadata: HmuxSessionSummary | undefined;
	healthState: HmuxPaneHealthState;
	health: PaneHealthReceipts | undefined;
}): string {
	const { metadata, health } = input;
	return [
		input.sessionLabel,
		metadata?.sessionClass,
		metadata?.hostBuildVersion && `host ${metadata.hostBuildVersion}`,
		metadata?.retirementPolicy && t("workspace.pane.autoCleanupOnLastClose"),
		`Hmux ${input.healthState}`,
		hmuxSessionDiagnosticDetail(metadata),
		health?.reason,
		health?.terminalEpoch ? `epoch ${health.terminalEpoch}` : undefined,
		health?.receivedSequence
			? `received ${health.receivedSequence}`
			: undefined,
		health?.presentedSequence
			? `presented ${health.presentedSequence}`
			: undefined,
	]
		.filter(Boolean)
		.join(" · ");
}
