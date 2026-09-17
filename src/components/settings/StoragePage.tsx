import { LoadingStatus } from "@/components/common/PanelStatus";
// Display the backend app_home resolver's paths and their origins. This page
// explains DURE_HOME overrides; cli/lib/migrate-home.mjs owns data migration.

import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Folder } from "lucide-react";
import { useEffect, useState } from "react";
import { PageTitle } from "@/components/settings/PageTitle";
import { Button } from "@/components/ui/button";
import { ErrorText } from "@/components/ui/error-text";
import { t } from "@/lib/i18n";
import { type AppHomeInfo, appHomeInfo } from "@/lib/ipc";
import { showToast } from "@/lib/toast";

function sourceLabel(source: AppHomeInfo["appRootSource"]): string {
	if (source === "env_override") return t("settings.storage.source.envOverride");
	if (source === "renamed") return t("settings.storage.source.renamed");
	return t("settings.storage.source.defaultLocation");
}

function LocationRow({
	name,
	description,
	path,
}: {
	name: string;
	description: string;
	path: string | undefined;
}) {
	if (!path) return null;
	return (
		// 첫 줄만 위 32px, 마지막 줄만 아래 32px — 나머지는 24px에 hairline 하나.
		// 조건부로 빠지는 줄이 있어도(경로 미해석) 실제로 그려진 첫/마지막 줄에
		// 붙도록 :first-child/:last-child로 둔다.
		<div className="flex w-full items-start gap-1.5 border-t border-border py-6 first:border-t-0 first:pt-8 last:pb-8">
			<div className="flex min-w-px flex-1 flex-col gap-1.5">
				<p className="text-sm font-medium text-foreground">{name}</p>
				<div className="flex w-full flex-col gap-1">
					<p className="text-xs text-muted-foreground">{description}</p>
					{/* 경로는 설명보다 한 단계 더 죽인다 — 읽을 문장이 아니라 확인하고
					    복사해 가는 값이라, 같은 톤이면 설명과 뭉쳐 읽힌다. */}
					<p
						className="break-all font-mono text-xs text-muted-foreground/80"
						data-selectable
					>
						{path}
					</p>
				</div>
			</div>
			<Button
				variant="outline"
				className="h-8 shrink-0 gap-2 rounded-md px-3 text-xs"
				onClick={() => {
					void revealItemInDir(path).catch(() =>
						showToast(t("common.openFailedPathMissing")),
					);
				}}
			>
				<Folder className="size-3" />
				{t("settings.storage.revealInFolder")}
			</Button>
		</div>
	);
}

export function StoragePage() {
	const [info, setInfo] = useState<AppHomeInfo | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		appHomeInfo()
			.then(setInfo)
			.catch((cause) => setError(String(cause)));
	}, []);

	return (
		<div>
			<PageTitle
				title={t("settings.storage.title")}
				desc={t("settings.storage.description")}
			/>
			{error ? (
				<ErrorText className="pt-8">{error}</ErrorText>
			) : !info ? (
				<LoadingStatus className="min-h-64" />
			) : (
				<>
					<div className="flex w-full flex-col">
						<LocationRow
							name={t("settings.storage.appHome.name")}
							description={`${t("settings.storage.appHome.desc")} · ${sourceLabel(info.appRootSource)}`}
							path={info.appRoot}
						/>
						<LocationRow
							name={t("settings.storage.appState.name")}
							description={t("settings.storage.appState.desc")}
							path={info.appDataDir ?? undefined}
						/>
						<LocationRow
							name={t("settings.storage.cliInstall.name")}
							description={t("settings.storage.cliInstall.desc")}
							path={info.cliInstallRoot}
						/>
						<LocationRow
							name={t("settings.storage.hmuxSessions.name")}
							description={t("settings.storage.hmuxSessions.desc")}
							path={info.discoveryRoot ?? undefined}
						/>
					</div>
					<p className="text-xs text-muted-foreground">
						{t("settings.storage.changeHint")}
					</p>
				</>
			)}
		</div>
	);
}
