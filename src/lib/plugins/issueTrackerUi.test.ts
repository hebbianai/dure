import { describe, expect, it } from "vitest";
import { t } from "@/lib/i18n";
import {
	issueTrackerErrorMessage,
	issueTrackerInitialMode,
	issueTrackerListModes,
	issueTrackerListQuery,
	issueTrackerWatchInterval,
} from "@/lib/plugins/issueTrackerUi";

describe("issue tracker contributed-view helpers", () => {
	it("reads the manifest-declared setting without assuming a Beads key", () => {
		expect(
			issueTrackerInitialMode(
				"ready",
				{ preferred_query: "list" },
				"preferred_query",
			),
		).toBe("list");
		expect(issueTrackerInitialMode("ready", { default_view: "list" })).toBe(
			"ready",
		);
		expect(issueTrackerListQuery("list")).toEqual({ kind: "list", limit: 100 });
		expect(issueTrackerListQuery("blocked")).toEqual({
			kind: "list_by_status",
			statuses: ["blocked"],
			limit: 100,
		});
		expect(issueTrackerListModes(["ready", "list", "human", "show"])).toEqual([
			"ready",
			"list",
			"blocked",
		]);
		expect(issueTrackerListModes(["human"])).toEqual(["human"]);
	});

	it("bounds watcher settings and keeps backend errors user-facing", () => {
		expect(
			issueTrackerWatchInterval({ poll_seconds: 10 }, "poll_seconds"),
		).toBe(10);
		expect(issueTrackerWatchInterval({ poll_seconds: 1 }, "poll_seconds")).toBe(
			30,
		);
		expect(
			issueTrackerErrorMessage("issue_tracker_workspace_has_no_beads"),
		).toContain("이슈 트래커");
		expect(issueTrackerErrorMessage("issue_tracker_embedded_engine")).toContain(
			"pnpm beads -- engine server",
		);
	});

	it("names the one thing a GitHub user can fix", () => {
		expect(
			issueTrackerErrorMessage("issue_tracker_github_auth_required"),
		).toBe(t("plugins.issueTracker.error.githubAuthRequired"));
		expect(
			issueTrackerErrorMessage("issue_tracker_workspace_has_no_github_remote"),
		).toBe(t("plugins.issueTracker.error.noGithubRemote"));
	});
});
