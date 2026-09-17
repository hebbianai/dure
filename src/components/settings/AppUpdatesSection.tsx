import { useEffect, useState, useSyncExternalStore } from "react";
import { UpdateNoticeCard } from "@/components/common/UpdateNoticeCard";
import {
	SettingRow,
	SettingsSection,
} from "@/components/settings/SettingsSection";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import { backendCapabilities } from "@/lib/ipc/core";
import {
	APP_UPDATE_SOURCE_REF,
	appUpdateCheckSnapshot,
	checkForAppUpdates,
	subscribeAppUpdateChecks,
} from "@/lib/platform/updater";
import { worktreeReleaseProfile } from "@/lib/platform/worktreeReleaseProfile";
import { useUpdateNoticeSnapshot } from "@/lib/updates/useUpdateNoticeSnapshot";

export function AppUpdatesSection() {
	const worktreeRelease = worktreeReleaseProfile();
	const [version, setVersion] = useState<string | null>();
	const status = useSyncExternalStore(
		subscribeAppUpdateChecks,
		appUpdateCheckSnapshot,
	);
	const notice = useUpdateNoticeSnapshot().notices.find(
		(entry) => entry.sourceRef === APP_UPDATE_SOURCE_REF,
	);
	useEffect(() => {
		let disposed = false;
		void backendCapabilities().then((capabilities) => {
			if (!disposed) setVersion(capabilities?.packageVersion ?? null);
		});
		return () => {
			disposed = true;
		};
	}, []);

	return (
		<SettingsSection
			label={t("settings.general.appUpdates.section")}
			first
			className="gap-3"
		>
			<SettingRow
				title={t("settings.general.appUpdates.installedVersion")}
				desc={
					version === undefined
						? t("common.loading")
						: (version ?? t("settings.general.appUpdates.versionUnavailable"))
				}
				align="center"
			>
				{!worktreeRelease && (
					<Button
						type="button"
						variant="outline"
						disabled={status === "checking" || notice?.phase === "running"}
						onClick={() => void checkForAppUpdates()}
					>
						{status === "checking"
							? t("settings.general.appUpdates.checking")
							: status === "error"
								? t("common.retry")
								: t("settings.general.appUpdates.check")}
					</Button>
				)}
			</SettingRow>
			{worktreeRelease && (
				<p className="text-xs text-muted-foreground">
					{t("settings.general.appUpdates.worktreeRebuild")}
				</p>
			)}
			{status === "error" ? (
				<p role="alert" className="text-xs text-destructive">
					{t("settings.general.appUpdates.failed")}
				</p>
			) : status === "checking" || status === "current" ? (
				<p role="status" className="text-xs text-muted-foreground">
					{status === "checking"
						? t("settings.general.appUpdates.checking")
						: status === "current"
							? t("settings.general.appUpdates.current")
							: null}
				</p>
			) : null}
			{notice && <UpdateNoticeCard notice={notice} />}
		</SettingsSection>
	);
}
