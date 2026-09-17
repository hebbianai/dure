import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import { openExternalUrl } from "@/lib/platform/externalOpen";
import type { GitAvailabilityState } from "./useGitAvailability";

export function GitAvailabilityNotice({
	state,
	recheck,
	hostName,
}: {
	state: GitAvailabilityState;
	recheck: () => void;
	hostName?: string;
}) {
	if (state.status === "available") return null;
	if (state.status === "checking") {
		return (
			<p role="status" className="text-xs text-muted-foreground">
				{t("panels.git.availability.checking")}
			</p>
		);
	}
	return (
		<Alert
			tone="warn"
			role="status"
			title={t(
				state.status === "missing"
					? "panels.git.availability.missing"
					: "panels.git.availability.unknown",
			)}
		>
			<div className="space-y-2">
				<p>
					{hostName
						? t("panels.git.availability.remote", { host: hostName })
						: t("panels.git.availability.local")}
				</p>
				{state.status === "unknown" && (
					<p className="break-words text-muted-foreground">{state.detail}</p>
				)}
				<div className="flex flex-wrap gap-2">
					{state.status === "missing" && (
						<Button
							variant="outline"
							size="sm"
							onClick={() =>
								void openExternalUrl("https://git-scm.com/downloads")
							}
						>
							{t("panels.git.availability.install")}
						</Button>
					)}
					<Button variant="ghost" size="sm" onClick={recheck}>
						{t("panels.git.availability.recheck")}
					</Button>
				</div>
			</div>
		</Alert>
	);
}
