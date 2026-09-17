// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "@/lib/i18n";
import type { DurePluginViewContainer } from "@/lib/plugins/durePlugins";
import { pluginSidebarContainerKey } from "@/lib/plugins/pluginSidebarSelection";
import { useWindowSidebarStore } from "@/lib/sidebar/windowSidebarStore";
import { useStore } from "@/store";

const mocks = vi.hoisted(() => ({
	openGitHubWorkspace: vi.fn(),
}));

vi.mock("@/components/plugins/IssueTrackerView", () => ({
	IssueTrackerView: ({ viewId }: { viewId: string }) => <div>Issue list: {viewId}</div>,
}));

vi.mock("@/components/github/GitHubWorkspacePanel", () => ({
	GitHubSidebarWorkspace: ({ projectId }: { projectId?: string }) => (
		<div>GitHub sidebar · {projectId}</div>
	),
}));

vi.mock("@/lib/workspace/dock/openGitHubWorkspacePanel", () => ({
	openGitHubWorkspacePanel: mocks.openGitHubWorkspace,
}));

import { PluginViewHost } from "@/components/plugins/PluginViewHost";

const githubContainer = {
	plugin: {
		manifest: {
			schema_version: 2,
			id: "dure.github",
			publisher: "dure",
			version: "0.1.0",
			display_name: "GitHub",
			host_api: { min_inclusive: 1, max_inclusive: 2 },
			agent_integrations: [],
		},
		compatibility: {
			status: "supported",
			negotiated_host_api_version: 2,
			contributions: [{ id: "dure.github.issue-tracker", family: "dure.issue-tracker", family_api_version: 1, placement: "workspace" }],
			ignored_optional_contributions: [],
			enabled_agent_integrations: [],
			ignored_optional_agent_integrations: [],
		},
		distribution: "bundled",
		installed: true,
		removable: false,
		settings_contribution: null,
		issue_tracker_contributions: [
			{
				contribution_id: "dure.github.issue-tracker",
				provider: {
					schema_version: 1,
					provider: "github",
					operations: ["list", "show"],
				},
			},
		],
		view_contributions: [],
	},
	contributionId: "dure.github.views",
	container: {
		id: "dure.github.issues",
		location: "primary_sidebar",
		title: { default: "GitHub" },
		icon: "github",
	},
	views: [
		{
			id: "dure.github.issues.list",
			container_id: "dure.github.issues",
			title: { default: "Issues" },
			kind: "issue_tracker",
			provider_contribution_id: "dure.github.issue-tracker",
			default_query: "list",
		},
	],
} as unknown as DurePluginViewContainer;

describe("PluginViewHost GitHub workspace entry", () => {
	beforeEach(() => {
		useWindowSidebarStore.setState({ pluginSelection: null });
		setLang("en");
		useStore.setState({
			language: "en",
			activeSpaceId: "space-1",
			focusCtx: {
				cwd: "/work/repo",
				source: "local",
				label: "repo",
			},
			projects: [
				{
					id: "project-1",
					name: "Repository",
					path: "/work/repo",
					kind: "local",
					isRepo: true,
				},
			],
		});
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
		useStore.setState({ focusCtx: null, projects: [] });
		setLang("ko");
	});

	it("opens the full GitHub work surface for the focused repository", () => {
		render(<PluginViewHost contribution={githubContainer} />);
		expect(screen.getByText("GitHub sidebar · project-1")).toBeTruthy();

		fireEvent.click(
			screen.getByRole("button", { name: "Open GitHub workspace" }),
		);

		expect(mocks.openGitHubWorkspace).toHaveBeenCalledWith(
			"space-1",
			"project-1",
			"Repository",
		);
	});

	it("follows external view navigation and retires a removed view without resurrecting it", () => {
		const contribution: DurePluginViewContainer = {
			...githubContainer,
			plugin: { ...githubContainer.plugin, manifest: { ...githubContainer.plugin.manifest, id: "example.tracker" } },
			views: [githubContainer.views[0], { ...githubContainer.views[0], id: "pane-claims", title: { default: "Claims" } }],
		};
		const { rerender } = render(<PluginViewHost contribution={contribution} />);
		act(() => useWindowSidebarStore.getState().openPluginView({ containerKey: pluginSidebarContainerKey(contribution), viewId: "pane-claims" }));
		expect(screen.getByText("Issue list: pane-claims")).toBeTruthy();
		rerender(<PluginViewHost contribution={{ ...contribution, views: [contribution.views[0]] }} />);
		expect(screen.getByText(`Issue list: ${contribution.views[0].id}`)).toBeTruthy();
		rerender(<PluginViewHost contribution={contribution} />);
		expect(screen.queryByText("Issue list: pane-claims")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Claims" }));
		expect(useWindowSidebarStore.getState().pluginSelection?.viewId).toBe("pane-claims");
	});
});
