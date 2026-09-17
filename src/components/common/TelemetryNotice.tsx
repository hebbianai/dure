import { useTelemetryState } from "@/components/common/useTelemetryState";
import { FLOATING_CARD } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import { openSettingsPage } from "@/lib/settings/settingsBus";

/** The one-time question about anonymous usage data (#961). Shown only while
 * the install has not answered; nothing is transmitted until it has. Two
 * answers and a link to the full list, no dismiss: an unanswered notice is
 * the same as "not yet", so there is nothing a close control would add.
 * `hidden` keeps the card mounted (one state load per window) while a modal
 * or an update card has the corner. */
export function TelemetryNotice({ hidden = false }: { hidden?: boolean }) {
	const { state, busy, choose } = useTelemetryState();
	if (hidden || state?.effective !== "pending") return null;
	return (
		<div className="fixed right-5 bottom-5 z-[100] w-[min(24rem,calc(100vw-2.5rem))]">
			<section
				aria-labelledby="telemetry-notice-title"
				className={`pointer-events-auto p-4 text-foreground ${FLOATING_CARD}`}
			>
				<h2 id="telemetry-notice-title" className="text-base font-semibold">
					{t("settings.privacy.notice.title")}
				</h2>
				<p
					role="status"
					aria-live="polite"
					className="mt-3 text-sm text-muted-foreground"
				>
					{t("settings.privacy.notice.body")}
				</p>
				<div className="mt-4 flex flex-wrap items-center gap-2">
					<Button
						type="button"
						size="sm"
						disabled={busy}
						onClick={() => void choose("accepted")}
					>
						{t("settings.privacy.notice.accept")}
					</Button>
					<Button
						type="button"
						size="sm"
						variant="outline"
						disabled={busy}
						onClick={() => void choose("declined")}
					>
						{t("settings.privacy.notice.decline")}
					</Button>
					<button
						type="button"
						className="ml-auto text-xs text-muted-foreground underline-offset-4 hover:underline"
						onClick={() => openSettingsPage("privacy")}
					>
						{t("settings.privacy.usageData.whatIsSent")}
					</button>
				</div>
			</section>
		</div>
	);
}
