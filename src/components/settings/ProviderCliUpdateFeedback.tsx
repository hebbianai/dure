import { t } from "@/lib/i18n";
import type { ProviderCliUpdateRunResult } from "@/lib/updates/providerCliUpdateRun";

export function ProviderCliUpdateFeedback({
	result,
}: {
	result: ProviderCliUpdateRunResult;
}) {
	if (
		result.kind !== "command_failed" &&
		result.kind !== "updated_with_warning"
	)
		return null;
	const guidance =
		result.guidance === "command_line_tools"
			? t("settings.providers.cliUpdate.commandLineTools")
			: result.guidance === "homebrew_pkgconf"
				? t("settings.providers.cliUpdate.homebrewPkgconf")
				: t("settings.providers.cliUpdate.reviewDetails");
	return (
		<div className="max-w-[600px] space-y-2 text-xs" role="status">
			<p
				className={
					result.kind === "command_failed"
						? "text-destructive"
						: "text-foreground"
				}
			>
				{result.kind === "updated_with_warning"
					? t("settings.providers.cliUpdate.updatedWithWarning", {
							version: result.toVersion,
						})
					: t("settings.providers.cliUpdate.failed")}
			</p>
			<p className="text-muted-foreground">{guidance}</p>
			{result.detail && (
				<details className="text-muted-foreground">
					<summary className="cursor-pointer">{t("common.details")}</summary>
					<pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-meta">
						{result.detail}
					</pre>
				</details>
			)}
		</div>
	);
}
