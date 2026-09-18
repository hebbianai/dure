// Settings › Privacy and telemetry — what this app sends, and what it does
// not. Four hairline-separated rows; the one control on the page is the
// anonymous-usage-data switch (#961), and it is wired to the native consent
// record, so what it shows is what happens. Every other row only states the
// current fact in a pill: a control that governs nothing is worse than none.

import {
	telemetryDocsUrl,
	useTelemetryState,
} from "@/components/common/useTelemetryState";
import { FlatRow } from "@/components/settings/FlatRow";
import { PageTitle } from "@/components/settings/PageTitle";
import { useGeneralPageState } from "@/components/settings/useGeneralPageState";
import { Switch } from "@/components/ui/switch";
import { resolveLang, t } from "@/lib/i18n";
import type { TelemetryDisabledReason } from "@/lib/ipc/telemetry";
import { openExternalUrl } from "@/lib/platform/externalOpen";
import { cn } from "@/lib/utils";

/** The pill for a row with nothing to choose: it states the current fact. */
function StatePill({
	children,
	tone,
}: {
	children: React.ReactNode;
	tone?: "good";
}) {
	return (
		<span
			className={cn(
				"shrink-0 rounded-full border px-2.5 py-0.5 text-[10.5px]",
				tone === "good"
					? "border-status-run/40 text-status-run"
					: "border-border text-muted-foreground",
			)}
		>
			{children}
		</span>
	);
}

/** The environment decided; the switch is shown off and cannot be moved. */
const ENVIRONMENT_REASONS: Partial<Record<TelemetryDisabledReason, string>> = {
	do_not_track: "settings.privacy.usageData.reason.doNotTrack",
	env_disabled: "settings.privacy.usageData.reason.envDisabled",
	ci: "settings.privacy.usageData.reason.ci",
};

function UsageDataControl() {
	const { state, busy, choose } = useTelemetryState();
	const { language } = useGeneralPageState();
	const title = t("settings.privacy.usageData.title");
	if (state === null) {
		return (
			<FlatRow title={title} desc={t("settings.privacy.usageData.desc")} />
		);
	}
	if (state.reason === "no_key") {
		return (
			<FlatRow title={title} desc={t("settings.privacy.usageData.desc")}>
				<StatePill>{t("settings.privacy.usageData.notInBuild")}</StatePill>
			</FlatRow>
		);
	}
	const environmentReason = state.reason && ENVIRONMENT_REASONS[state.reason];
	return (
		<>
			<FlatRow title={title} desc={t("settings.privacy.usageData.desc")}>
				<Switch
					checked={state.effective === "enabled"}
					disabled={busy || Boolean(environmentReason)}
					aria-label={title}
					onCheckedChange={(checked) =>
						void choose(checked ? "accepted" : "declined")
					}
				/>
			</FlatRow>
			{environmentReason ? (
				<p className="text-xs text-muted-foreground">{t(environmentReason)}</p>
			) : null}
			<button
				type="button"
				className="self-start text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
				onClick={() =>
					void openExternalUrl(telemetryDocsUrl(resolveLang(language)))
				}
			>
				{t("settings.privacy.usageData.whatIsSent")}
			</button>
		</>
	);
}

export function PrivacyPage() {
	return (
		<>
			<PageTitle
				title={t("settings.privacy.title")}
				desc={t("settings.privacy.description")}
			/>
			<div className="flex w-full flex-col">
				<section className="flex w-full flex-col gap-3 pt-2 pb-6">
					<UsageDataControl />
				</section>

				<section className="flex w-full flex-col border-t border-border py-6">
					<FlatRow
						title={t("settings.privacy.diagnostics.title")}
						desc={t("settings.privacy.diagnostics.desc")}
					>
						<StatePill>
							{t("settings.privacy.diagnostics.onlyOnYourAction")}
						</StatePill>
					</FlatRow>
				</section>

				<section className="flex w-full flex-col border-t border-border py-6">
					<FlatRow
						title={t("settings.privacy.credentials.title")}
						desc={t("settings.privacy.credentials.desc")}
					>
						<StatePill>
							{t("settings.privacy.credentials.deviceOnly")}
						</StatePill>
					</FlatRow>
				</section>

				<section className="flex w-full flex-col border-t border-border py-6">
					<FlatRow
						title={t("settings.privacy.feedback.title")}
						desc={t("settings.privacy.feedback.desc")}
					>
						<StatePill>{t("settings.privacy.feedback.onlyWhenSent")}</StatePill>
					</FlatRow>
				</section>
			</div>
		</>
	);
}
