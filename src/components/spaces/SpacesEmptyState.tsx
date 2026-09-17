import { Folder, FolderPlus } from "lucide-react";
import { PanelStatus } from "@/components/common/PanelStatus";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import { openOnboardingPanel } from "@/lib/onboarding/onboardingEntry";
import type { SpacesEmptyStateKind } from "@/lib/spaces/spacesEmptyState";

export function SpacesEmptyState({
	query,
	kind,
	onClearQuery,
	filtersActive = false,
	onResetFilters,
	onAddFolder,
	desktopId,
}: {
	query: string;
	kind: SpacesEmptyStateKind;
	onClearQuery: () => void;
	filtersActive?: boolean;
	onResetFilters?: () => void;
	onAddFolder: () => void;
	/** 첫 실행 가이드를 열 데스크탑 — 자동 표시를 닫은 뒤의 복귀 경로다. */
	desktopId?: string;
}) {
	if (kind === "no_locations") {
		return (
			<PanelStatus
				role="status"
				className="min-h-0 flex-1 gap-6 overflow-y-auto px-5 py-8 text-center"
			>
				<span className="sr-only">{t("spaces.empty.noFolders")}</span>
				<Folder
					aria-hidden
					className="size-12 shrink-0 fill-foreground/10"
					strokeWidth={1.25}
				/>
				<div className="flex max-w-full flex-col items-center gap-2">
					<Button variant="glass" onClick={onAddFolder}>
						<FolderPlus aria-hidden />
						{t("spaces.empty.addFolder")}
					</Button>
					{desktopId ? (
						<Button
							variant="link"
							size="sm"
							className="h-auto max-w-full whitespace-normal text-meta font-normal text-muted-foreground"
							onClick={() => openOnboardingPanel(desktopId)}
						>
							{t("common.openGettingStarted")}
						</Button>
					) : null}
				</div>
			</PanelStatus>
		);
	}
	return (
		<div className="flex flex-col items-start gap-1.5 px-4 py-3" role="status">
			<p className="text-xs text-muted-foreground">
				{kind === "no_match"
					? t("spaces.empty.noMatches")
					: t("spaces.empty.noSessions")}
			</p>
			{kind === "no_match" && (
				<>
					{query && (
						<button
							type="button"
							className="text-xs text-sidebar-foreground underline-offset-2 hover:underline"
							onClick={onClearQuery}
						>
							{t("common.clearSearch")}
						</button>
					)}
					{filtersActive && onResetFilters && (
						<button
							type="button"
							className="text-xs text-sidebar-foreground underline-offset-2 hover:underline"
							onClick={onResetFilters}
						>
							{t("spaces.pane.resetFilters")}
						</button>
					)}
				</>
			)}
			{kind === "no_sessions" && (
				<p className="text-xs text-muted-foreground opacity-70">
					{t("spaces.empty.useAddButton")}
				</p>
			)}
		</div>
	);
}
