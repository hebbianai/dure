import type { DurePluginPermissionSnapshot } from "@/lib/ipc/plugins";

export function pluginPermissionReviewFixture(
	planDigest: string,
	reviewedPlanDigest: string | null,
): DurePluginPermissionSnapshot["review"] {
	return {
		current: {
			schema_version: 2,
			plan_digest: planDigest,
			entries: [],
			projection_digest: `sha256:${"f".repeat(64)}`,
		},
		comparison: reviewedPlanDigest
			? {
					status: "matches_reviewed_projection",
					reviewed_plan_digest: reviewedPlanDigest,
				}
			: { status: "no_reviewed_plan" },
	};
}
