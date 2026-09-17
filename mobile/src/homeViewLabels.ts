import type { SpacesFacetBucket } from "@/lib/spaces/spacesViewProjection";
import type {
	SpacesEnvironment,
	SpacesStatusFilter,
	SpacesSource,
} from "@/lib/spaces/spacesViewOptions";
import { t } from "./i18n";

export function environmentLabel(value: SpacesEnvironment): string {
	return t(
		value === "local"
			? "spaces.pane.environmentLocal"
			: value === "ssh"
				? "spaces.pane.environmentSsh"
				: "common.unknown",
	);
}

export function statusLabel(value: SpacesStatusFilter): string {
	const keys = {
		unknown: "common.unknown",
		working: "common.working",
		error: "agents.status.error",
		input: "agents.status.awaitingInput",
		blocked: "agents.status.approvalRequired",
		waiting: "agents.status.awaitingResponse",
		connecting: "common.connecting",
		exited: "common.exited",
	};
	return t(keys[value]);
}

export function sourceLabel(value: SpacesSource): string {
	return value.startsWith("provider:")
		? value.slice(9)
		: t(value === "ssh" ? "spaces.pane.sourceSsh" : "spaces.pane.sourceShell");
}

export function facetLabel(bucket: SpacesFacetBucket): string {
	if (bucket.axis === "location") return bucket.label ?? t("common.unknown");
	if (bucket.axis === "environment") return environmentLabel(bucket.value);
	if (bucket.axis === "status") return statusLabel(bucket.value);
	const keys = {
		today: "spaces.group.updatedToday",
		yesterday: "spaces.group.updatedYesterday",
		lastSevenDays: "spaces.group.updatedLastSevenDays",
		older: "spaces.group.updatedOlder",
		unknown: "common.unknown",
	};
	return t(keys[bucket.value]);
}
