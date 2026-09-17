import type { ReactNode } from "react";
import { SectionHeaderRow } from "@/components/sidebar/SidebarItems";
import { SearchField } from "@/components/ui/search-field";
import { t } from "@/lib/i18n";

interface SpacesPaneHeaderProps {
	actions: ReactNode;
	query: string;
	onQueryChange: (query: string) => void;
}

export function SpacesPaneHeader({
	actions,
	query,
	onQueryChange,
}: SpacesPaneHeaderProps) {
	return (
		<>
			<SectionHeaderRow
				as="h2"
				className="shrink-0"
				label={t("common.space")}
				actions={actions}
			/>
			{/* Same band as the File tab (FileTree): 14px above the field, 8px
			    below it. The sidebar tabs take turns in one column, so a title →
			    search → first row that shifts when you switch tabs reads as the
			    panel moving under you. */}
			<div className="shrink-0 px-3 pt-3.5 pb-2">
				<SearchField
					aria-label={t("spaces.pane.searchPlaceholder")}
					inputClassName="h-8"
					onChange={(event) => onQueryChange(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Escape") onQueryChange("");
					}}
					placeholder={t("spaces.pane.searchPlaceholder")}
					value={query}
				/>
			</div>
		</>
	);
}
