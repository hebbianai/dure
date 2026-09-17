import { activityLabel } from "@/components/agents/StatusBits";
import { t } from "@/lib/i18n";
import type { SpacesEnvironment } from "@/lib/spaces/spacesViewOptions";
import type { SpacesFacetBucket } from "@/lib/spaces/spacesViewProjection";

export function spacesEnvironmentLabel(
	environment: SpacesEnvironment,
): string {
	if (environment === "local") return t("spaces.pane.environmentLocal");
	if (environment === "ssh") return t("spaces.pane.environmentSsh");
	return t("common.unknown");
}

export function spacesFacetLabel(bucket: SpacesFacetBucket): string {
	if (bucket.axis === "location") {
		return bucket.label ?? t("common.unknown");
	}
	if (bucket.axis === "environment") {
		return spacesEnvironmentLabel(bucket.value);
	}
	if (bucket.axis === "status") {
		return bucket.value === "unknown"
			? t("common.unknown")
			: activityLabel(bucket.value);
	}
	switch (bucket.value) {
		case "today":
			return t("spaces.group.updatedToday");
		case "yesterday":
			return t("spaces.group.updatedYesterday");
		case "lastSevenDays":
			return t("spaces.group.updatedLastSevenDays");
		case "older":
			return t("spaces.group.updatedOlder");
		case "unknown":
			return t("common.unknown");
	}
}
