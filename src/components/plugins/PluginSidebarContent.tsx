import { CircleAlert, Puzzle } from "lucide-react";
import { DureLoader } from "@/components/ui/dure-loader";
import { PluginViewHost } from "@/components/plugins/PluginViewHost";
import { SectionHeaderRow } from "@/components/sidebar/SidebarItems";
import { Button } from "@/components/ui/button";
import { GlassPanel } from "@/components/ui/glass-panel";
import { t } from "@/lib/i18n";
import type { DurePluginViewContainer } from "@/lib/plugins/durePlugins";
import type { PluginCatalogResourceSnapshot } from "@/lib/plugins/pluginCatalogResource";

export function PluginSidebarContent({
	contribution,
	loadState,
	onOpenCatalog,
	onRetry,
}: {
	contribution: DurePluginViewContainer | undefined;
	loadState: PluginCatalogResourceSnapshot["loadState"];
	onOpenCatalog: () => void;
	onRetry: () => void;
}) {
	if (contribution) return <PluginViewHost contribution={contribution} />;

	const loading = loadState === "idle" || loadState === "loading";
	const failed = loadState === "error";
	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col pt-1.5">
			<SectionHeaderRow as="h2" label={t("common.plugin")} />
			<GlassPanel className="mx-3 mt-3 flex flex-col items-center gap-3 px-4 py-6 text-center">
				<div
					role={failed ? "alert" : "status"}
					className="flex flex-col items-center gap-3"
				>
					{loading ? (
						<DureLoader size={20} decorative className="text-muted-foreground" />
					) : failed ? (
						<CircleAlert
							aria-hidden="true"
							className="size-5 text-destructive"
						/>
					) : (
						<Puzzle
							aria-hidden="true"
							className="size-5 text-muted-foreground"
						/>
					)}
					<p className="text-xs leading-5 text-muted-foreground">
						{loading
							? t("common.loading")
							: failed
								? t("plugins.views.loadFailed")
								: t("plugins.views.unavailable")}
					</p>
				</div>
				{!loading && (
					<div className="flex flex-wrap justify-center gap-2">
						{failed && (
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={onRetry}
							>
								{t("common.retry")}
							</Button>
						)}
						<Button
							type="button"
							variant="secondary"
							size="sm"
							onClick={onOpenCatalog}
						>
							{t("plugins.views.openCatalog")}
						</Button>
					</div>
				)}
			</GlassPanel>
		</div>
	);
}
