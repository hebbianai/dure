import { describe, expect, it } from "vitest";
import type {
	DurePluginCatalogEntry,
	DurePluginCatalogSnapshotV2,
} from "@/lib/plugins/durePlugins";
import {
	agentIntegrationNames,
	availablePluginCatalogEntries,
	isDurePluginSupported,
	issueTrackerContribution,
	pluginAgentClaimViews,
	pluginCatalogOutcomeKey,
	pluginDescription,
	pluginHasSettings,
	pluginLocalizedText,
	pluginSettingsForScope,
	pluginSettingsTarget,
	pluginViewContainers,
	pluginWorkflowActions,
	pluginWorkspaceBooleanDefault,
	uniquePluginWorkflowAction,
} from "@/lib/plugins/durePlugins";

const entry: DurePluginCatalogEntry = {
	manifest: {
		schema_version: 2,
		id: "dure.beads",
		publisher: "dure",
		version: "0.2.0",
		display_name: "Beads",
		description:
			"Beads 패키지에는 Codex와 Claude Code 연동 플러그인이 함께 포함되어 있습니다.",
		host_api: { min_inclusive: 1, max_inclusive: 2 },
		agent_integrations: [
			{
				id: "dure.beads.codex",
				adapter: "codex",
				required: false,
				resource: "./agents/codex",
				selector: { plugin: "dure-beads", marketplace: "dure-bundled" },
			},
			{
				id: "dure.beads.claude",
				adapter: "claude",
				required: false,
				resource: "./agents/claude",
				selector: { plugin: "dure-beads", marketplace: "dure-bundled" },
			},
		],
		contributions: [
			{
				id: "dure.beads.issue-tracker",
				family: "dure.issue-tracker",
				family_api: { min_inclusive: 1, max_inclusive: 1 },
				required: true,
				placement: "workspace",
				resource: "./contributions/issue-tracker.json",
			},
			{
				id: "dure.beads.views",
				family: "dure.views",
				family_api: { min_inclusive: 1, max_inclusive: 1 },
				required: true,
				placement: "ui",
				resource: "./contributions/views.json",
			},
		],
	},
	compatibility: {
		status: "supported",
		negotiated_host_api_version: 2,
		contributions: [
			{
				id: "dure.beads.issue-tracker",
				family: "dure.issue-tracker",
				family_api_version: 1,
				placement: "workspace",
			},
			{
				id: "dure.beads.views",
				family: "dure.views",
				family_api_version: 1,
				placement: "ui",
			},
		],
		ignored_optional_contributions: [],
		enabled_agent_integrations: ["dure.beads.codex", "dure.beads.claude"],
		ignored_optional_agent_integrations: [],
	},
	distribution: "bundled",
	installed: true,
	removable: false,
	settings_contribution: {
		target: {
			identity: {
				source_id: "dure.bundled",
				candidate_id: "dure.beads.bundled",
			},
			plugin_id: "dure.beads",
			version: "0.2.0",
			contribution_id: "dure.beads.settings",
		},
		contribution_id: "dure.beads.settings",
		schema: {
			schema_version: 1,
			settings: [
				{
					kind: "boolean",
					key: "notifications",
					title: "알림",
					description: "알림",
					scope: "user",
					default: true,
				},
				{
					kind: "integer",
					key: "watch_interval_seconds",
					title: "주기",
					description: "주기",
					scope: "workspace",
					default: 30,
					minimum: 5,
					maximum: 300,
				},
				{
					kind: "choice",
					key: "default_view",
					title: "기본 보기",
					description: "기본 보기",
					scope: "workspace",
					default: "ready",
					options: [
						{ value: "ready", label: "진행 가능" },
						{ value: "list", label: "모든 열린 작업" },
					],
				},
				{
					kind: "boolean",
					key: "show_agent_claims",
					title: "Pane별 claim",
					description: "Pane별 claim",
					scope: "workspace",
					default: true,
				},
			],
		},
	},
	issue_tracker_contributions: [
		{
			contribution_id: "dure.beads.issue-tracker",
			provider: {
				schema_version: 1,
				provider: "beads",
				operations: ["human", "list", "ready", "show", "watch"],
				prefer_repository_wrapper: false,
				repository_wrapper: null,
				mutation_delivery: null,
				agent_binding: {
					kind: "scm_branch_metadata",
					metadata_key: "dure_worktree_branch",
				},
			},
		},
	],
	view_contributions: [
		{
			contribution_id: "dure.beads.views",
			views: {
				schema_version: 1,
				containers: [
					{
						id: "dure.beads.issues",
						location: "primary_sidebar",
						title: { default: "Beads" },
						icon: "list_todo",
					},
				],
				views: [
					{
						id: "dure.beads.issues.list",
						container_id: "dure.beads.issues",
						title: { default: "이슈", translations: { en: "Issues" } },
						kind: "issue_tracker",
						provider_contribution_id: "dure.beads.issue-tracker",
						default_query: "ready",
						default_query_setting_key: "default_view",
						watch_interval_setting_key: "watch_interval_seconds",
						agent_claims: {
							title: {
								default: "Pane별 claim",
								translations: { en: "Claims by pane" },
							},
							setting_key: "show_agent_claims",
							statuses: ["in_progress"],
							surfaces: ["primary_sidebar", "agent_pane_claim_status"],
						},
					},
				],
			},
		},
	],
};

describe("Dure plugin presentation model", () => {
	it("projects bundled agent integrations from the negotiated contract", () => {
		expect(isDurePluginSupported(entry)).toBe(true);
		expect(agentIntegrationNames(entry)).toEqual(["codex", "claude"]);
		expect(pluginDescription(entry)).toBe(entry.manifest.description);
		expect(
			pluginDescription({
				...entry,
				manifest: { ...entry.manifest, description: undefined },
			}),
		).toBe("플러그인이 설명을 제공하지 않았습니다.");
	});

	it("keeps plugin settings separated by scope", () => {
		expect(
			pluginSettingsForScope(entry.settings_contribution?.schema, "user").map(
				(setting) => setting.key,
			),
		).toEqual(["notifications"]);
		expect(
			pluginSettingsForScope(
				entry.settings_contribution?.schema,
				"workspace",
			).map((setting) => setting.key),
		).toEqual(["watch_interval_seconds", "default_view", "show_agent_claims"]);
		expect(pluginHasSettings(entry)).toBe(true);
		expect(pluginWorkspaceBooleanDefault(entry, "show_agent_claims")).toBe(
			true,
		);

		const agentOnly = { ...entry, settings_contribution: null };
		expect(pluginSettingsForScope(null, "user")).toEqual([]);
		expect(pluginHasSettings(agentOnly)).toBe(false);
		expect(
			pluginWorkspaceBooleanDefault(agentOnly, "show_agent_claims"),
		).toBeUndefined();

		const mismatched = structuredClone(entry);
		mismatched.settings_contribution!.target.version = "9.0.0";
		expect(pluginHasSettings(mismatched)).toBe(false);
		expect(pluginSettingsTarget(mismatched)).toBeNull();

		const missingSettings = structuredClone(entry);
		missingSettings.settings_contribution!.schema.settings = undefined;
		expect(pluginHasSettings(missingSettings)).toBe(false);
		expect(pluginSettingsTarget(missingSettings)).toBeNull();
	});

	it("projects only available packages from mixed catalog outcomes", () => {
		const snapshot = {
			schema_version: 2,
			outcomes: [
				{
					status: "rejected",
					identity: { source_id: "dure.installed", candidate_id: "broken" },
					manifest: null,
					reason: { kind: "source_rejected" },
				},
				{
					status: "available",
					identity: { source_id: "dure.bundled", candidate_id: "beads" },
					entry,
				},
				{
					status: "conflict",
					plugin_id: "example.duplicate",
					candidates: [],
				},
			],
		} satisfies DurePluginCatalogSnapshotV2;

		expect(availablePluginCatalogEntries(snapshot)).toEqual([entry]);
		expect(snapshot.outcomes.map(pluginCatalogOutcomeKey)).toEqual([
			"rejected:dure.installed:broken",
			"available:dure.beads",
			"conflict:example.duplicate",
		]);
	});

	it("projects only negotiated plugin-owned view containers", () => {
		expect(pluginViewContainers([entry])).toHaveLength(1);
		expect(pluginViewContainers([entry])[0]).toMatchObject({
			contributionId: "dure.beads.views",
			container: { id: "dure.beads.issues" },
			views: [{ id: "dure.beads.issues.list" }],
		});
		expect(
			issueTrackerContribution(entry, "dure.beads.issue-tracker")?.provider
				.provider,
		).toBe("beads");
		expect(
			pluginLocalizedText(
				{ default: "이슈", translations: { en: "Issues" } },
				"en",
			),
		).toBe("Issues");

		if (entry.compatibility.status !== "supported") {
			throw new Error("test fixture must be supported");
		}
		const supportedCompatibility = entry.compatibility;
		const providerNotNegotiated: DurePluginCatalogEntry = {
			...entry,
			compatibility: {
				...supportedCompatibility,
				contributions: supportedCompatibility.contributions.filter(
					(contribution) => contribution.family !== "dure.issue-tracker",
				),
			},
		};
		expect(pluginViewContainers([providerNotNegotiated])).toEqual([]);
		expect(
			issueTrackerContribution(
				providerNotNegotiated,
				"dure.beads.issue-tracker",
			),
		).toBeUndefined();

	});

	it("projects one negotiated workflow action and fails closed on ambiguity", () => {
		if (entry.compatibility.status !== "supported") {
			throw new Error("test fixture must be supported");
		}
		const workflowEntry: DurePluginCatalogEntry = {
			...entry,
			manifest: {
				...entry.manifest,
				id: "dure.core",
				contributions: [
					{
						id: "dure.core.delegate-once",
						family: "dure.workflows",
						family_api: { min_inclusive: 1, max_inclusive: 1 },
						required: true,
						placement: "ui",
						resource: "./contributions/workflows.json",
					},
				],
			},
			compatibility: {
				...entry.compatibility,
				contributions: [
					{
						id: "dure.core.delegate-once",
						family: "dure.workflows",
						family_api_version: 1,
						placement: "ui",
					},
				],
			},
			settings_contribution: null,
			issue_tracker_contributions: [],
			view_contributions: [],
			workflow_contributions: [
				{
					contribution_id: "dure.core.delegate-once",
					workflow: {
						schema_version: 1,
						kind: "workflow.delegate_once",
						title: {
							default: "작업 위임",
							translations: { en: "Delegate task" },
						},
						description: { default: "worker 하나를 시작합니다." },
					},
				},
			],
		};

		expect(
			pluginWorkflowActions([workflowEntry], "workflow.delegate_once"),
		).toEqual([
			expect.objectContaining({ contributionId: "dure.core.delegate-once" }),
		]);
		expect(
			uniquePluginWorkflowAction([workflowEntry], "workflow.delegate_once")
				?.contributionId,
		).toBe("dure.core.delegate-once");

		const notNegotiated = structuredClone(workflowEntry);
		if (notNegotiated.compatibility.status !== "supported") {
			throw new Error("test fixture must be supported");
		}
		notNegotiated.compatibility.contributions = [];
		expect(
			pluginWorkflowActions([notNegotiated], "workflow.delegate_once"),
		).toEqual([]);

		const competing = structuredClone(workflowEntry);
		if (competing.compatibility.status !== "supported") {
			throw new Error("test fixture must be supported");
		}
		competing.manifest.id = "example.workflow";
		competing.compatibility.contributions[0]!.id =
			"example.workflow.delegate-once";
		competing.workflow_contributions![0]!.contribution_id =
			"example.workflow.delegate-once";
		expect(
			uniquePluginWorkflowAction(
				[workflowEntry, competing],
				"workflow.delegate_once",
			),
		).toBeUndefined();
	});

	it("projects agent claims only onto explicitly declared surfaces", () => {
		expect(pluginAgentClaimViews([entry], "primary_sidebar")).toEqual([
			expect.objectContaining({ viewContributionId: "dure.beads.views" }),
		]);
		expect(
			pluginAgentClaimViews([entry], "agent_pane_claim_status"),
		).toHaveLength(1);

		const sidebarOnly = structuredClone(entry);
		const view = sidebarOnly.view_contributions[0]?.views.views[0];
		if (view?.kind !== "issue_tracker" || !view.agent_claims) {
			throw new Error("test fixture must declare issue tracker agent claims");
		}
		view.agent_claims.surfaces = ["primary_sidebar"];
		expect(
			pluginAgentClaimViews([sidebarOnly], "primary_sidebar"),
		).toHaveLength(1);
		expect(
			pluginAgentClaimViews([sidebarOnly], "agent_pane_claim_status"),
		).toEqual([]);

		const repeatedViewId = structuredClone(entry);
		const secondViews = structuredClone(repeatedViewId.view_contributions[0]);
		if (!secondViews || repeatedViewId.compatibility.status !== "supported") {
			throw new Error("test fixture must expose a negotiated view contribution");
		}
		secondViews.contribution_id = "dure.beads.views.secondary";
		repeatedViewId.view_contributions.push(secondViews);
		repeatedViewId.compatibility.contributions.push({
			id: secondViews.contribution_id,
			family: "dure.views",
			family_api_version: 1,
			placement: "ui",
	});
		expect(
			pluginAgentClaimViews([repeatedViewId], "primary_sidebar").map(
				(source) => source.viewContributionId,
			),
		).toEqual(["dure.beads.views", "dure.beads.views.secondary"]);
});
});
